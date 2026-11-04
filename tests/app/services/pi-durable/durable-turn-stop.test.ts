import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../../src/contracts/conversations/session-contract";
import { createDurableTurnStop } from "../../../../src/services/pi-durable/durable-turn-stop";
import { snapshot } from "../../helpers/piRuntimeFixture";

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const running: ConversationSnapshot = {
  ...snapshot,
  streaming: true,
  parts: [
    { id: "reply", kind: "text", role: "assistant", text: "Keep this", status: "streaming" },
    {
      id: "queued",
      kind: "text",
      role: "user",
      text: "Queued input",
      status: "complete",
      deliveryState: "queued",
    },
  ],
};

function fixture() {
  const cleanup = deferred();
  const published = deferred();
  const onEvent = vi.fn();
  const stop = vi.fn(() => cleanup.promise);
  const controller = createDurableTurnStop({
    stop,
    onEvent,
    publish: () => published.resolve(),
    isDisposed: () => false,
  });
  controller.project(running);
  return { cleanup, published, onEvent, stop, controller };
}

describe("Durable immediate Stop", () => {
  it("acknowledges without joining a hung task, freezes output and retains an editable queue", async () => {
    const f = fixture();
    await f.controller.abort();
    expect(f.stop).toHaveBeenCalledOnce();
    const stopped = f.onEvent.mock.calls[0]![0].snapshot as ConversationSnapshot;
    expect(stopped.streaming).toBe(false);
    expect(stopped.parts).toContainEqual(
      expect.objectContaining({ id: "reply", text: "Keep this", status: "complete" }),
    );
    expect(stopped.parts).toContainEqual(
      expect.objectContaining({ id: "abort-cleanup", title: "Cancellation requested" }),
    );
    const late = f.controller.project({
      ...running,
      parts: [
        {
          id: "late",
          kind: "text",
          role: "assistant",
          text: "Do not stream this",
          status: "complete",
        },
      ],
    });
    expect(late.streaming).toBe(false);
    expect(late.parts.map((part) => part.id)).toEqual(["reply", "abort-cleanup"]);
    expect(late.parts).not.toContainEqual(expect.objectContaining({ id: "queued" }));
    f.cleanup.resolve();
    await f.published.promise;
    expect(f.controller.project(running).parts.map((part) => part.id)).toEqual(["reply", "queued"]);
  });

  it("holds the next input until cleanup completes, then permits a new turn", async () => {
    const f = fixture();
    await f.controller.abort();
    const entered = vi.fn();
    const next = f.controller.beforeInput().then((check) => {
      check();
      entered();
    });
    await Promise.resolve();
    expect(entered).not.toHaveBeenCalled();
    f.cleanup.resolve();
    await next;
    expect(entered).toHaveBeenCalledOnce();
    expect(f.controller.project(running)).toBe(running);
  });

  it("does not resume waiting input or prepared side effects after another Stop", async () => {
    const f = fixture();
    const prepared = await f.controller.beforeInput();
    await f.controller.abort();
    expect(prepared).toThrow("Session was aborted");
    const waiting = f.controller.beforeInput().catch((error: Error) => error.message);
    await f.controller.abort();
    f.cleanup.resolve();
    expect(await waiting).toBe("Session was aborted");
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure rather than claiming the underlying task stopped", async () => {
    const f = fixture();
    await f.controller.abort();
    const failure = new Error("Uncancellable tool failed");
    f.cleanup.reject(failure);
    await f.published.promise;
    await expect(f.controller.beforeInput()).rejects.toBe(failure);
    expect(f.controller.project(running).parts).toContainEqual(
      expect.objectContaining({
        id: "abort-cleanup",
        title: "Cancellation cleanup failed",
        tone: "error",
      }),
    );
  });
});
