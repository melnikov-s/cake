import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createCakeSessionRuntimeTurnController } from "../../../../src/services/pi/runtime/cake-session-runtime-turn-controller";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  execute: (command: string) => Promise<void>,
  overrides: Partial<AgentSession> = {},
) {
  const followUp: string[] = [];
  const steering: string[] = [];
  const session = {
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: SessionManager.inMemory("/project"),
    getFollowUpMessages: () => followUp,
    getSteeringMessages: () => steering,
    clearQueue: () => ({ steering: steering.splice(0), followUp: followUp.splice(0) }),
    steer: vi.fn(async (text: string) => {
      steering.push(text);
      return "queued";
    }),
    followUp: vi.fn(async (text: string) => {
      followUp.push(text);
      return "queued";
    }),
    prompt: vi.fn(async (text: string) => {
      if (session.isStreaming) followUp.push(text);
    }),
    abort: vi.fn(async () => {
      Object.assign(session, { isStreaming: false, isCompacting: false });
    }),
    ...overrides,
  } as unknown as AgentSession;
  const emitPart = vi.fn();
  const controller = createCakeSessionRuntimeTurnController({
    session,
    isDisposed: () => false,
    allowUserBash: true,
    beforeIdleTurn: async () => undefined,
    withResponseRetries: (operation) => operation(),
    cancelResponseRetries: vi.fn(),
    recovery: { onUserInput: vi.fn(), onAbort: vi.fn() },
    deliverTrackedUserMessage: (_content, _markdown, deliver) => deliver(),
    syncQueuedParts: vi.fn(),
    emitPart,
    emitSnapshot: async () => undefined,
    emitSnapshotInBackground: vi.fn(),
    executeQueuedCommand: execute,
  });
  const settle = () => {
    Object.assign(session, { isStreaming: false });
    controller.settleTurn();
  };
  return { controller, session, emitPart, settle, followUp, steering };
}

describe("queued session commands", () => {
  it("orders commands with messages, supports reordering, and waits for command completion before the next message", async () => {
    const started = deferred();
    const release = deferred();
    const delivered = deferred();
    const execute = vi.fn(async () => {
      started.resolve();
      await release.promise;
    });
    const { controller, session, settle, followUp } = fixture(execute);
    await controller.prompt("Earlier", "follow-up", []);
    const receipt = await controller.queueCommand("/compact keep decisions");
    await controller.prompt("Later", "follow-up", []);
    expect(receipt.status).toBe("queued");
    expect(execute).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(followUp).toEqual([]);
    expect(
      (await controller.pendingMessages()).items.map(({ text, state }) => [text, state]),
    ).toEqual([
      ["Earlier", "compaction-held"],
      ["/compact keep decisions", "command-queued"],
      ["Later", "compaction-held"],
    ]);
    await controller.reorderPendingMessage({ itemId: receipt.itemId, position: 1 });
    vi.mocked(session.prompt).mockImplementation(async (text) => {
      if (text.startsWith("Later")) delivered.resolve();
    });
    settle();
    await started.promise;
    expect(session.prompt).toHaveBeenCalledTimes(1); // Only the original queue submission.
    release.resolve();
    await delivered.promise;
    expect(execute).toHaveBeenCalledWith("/compact keep decisions");
    expect(
      vi
        .mocked(session.prompt)
        .mock.calls.slice(1)
        .map(([text]) => text.split("\n")[0]),
    ).toEqual(["Earlier", "Later"]);
    controller.dispose();
  });

  it("cancels one duplicate command by identity and rejects steering commands", async () => {
    const executed = deferred();
    const settledFirst = vi.fn();
    const settledSecond = vi.fn();
    const execute = vi.fn(async () => {
      executed.resolve();
    });
    const { controller, settle } = fixture(execute);
    const first = await controller.queueCommand("/toolcompact", settledFirst);
    const second = await controller.queueCommand("/toolcompact", settledSecond);
    const items = (await controller.pendingMessages()).items;
    await expect(controller.steerQueuedMessage(items[1]!.partId!)).rejects.toThrow(
      "cannot be steered",
    );
    await controller.removeQueuedMessage(items[1]!.partId!);
    expect(settledSecond).toHaveBeenCalledTimes(1);
    expect(settledFirst).not.toHaveBeenCalled();
    expect((await controller.pendingMessages()).items.map(({ itemId }) => itemId)).toEqual([
      first.itemId,
    ]);
    expect(first.itemId).not.toBe(second.itemId);
    settle();
    await executed.promise;
    controller.dispose();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports command failure and proceeds to the next queued command", async () => {
    const finished = deferred();
    const execute = vi.fn(async (command: string) => {
      if (command === "/compact") throw new Error("Provider unavailable");
      finished.resolve();
    });
    const { controller, settle, emitPart } = fixture(execute);
    await controller.queueCommand("/compact");
    await controller.queueCommand("/toolcompact");
    settle();
    await finished.promise;
    expect(emitPart).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notice",
        tone: "error",
        title: "Queued command failed",
        detail: expect.stringContaining("Provider unavailable"),
      }),
    );
    controller.dispose();
  });

  it("starts idle commands without an agent turn and notifies completion", async () => {
    const completed = deferred();
    const execute = vi.fn(async () => undefined);
    const { controller, session } = fixture(execute, { isStreaming: false });
    await controller.queueCommand("/toolcompact", completed.resolve);
    await completed.promise;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
    expect((await controller.pendingMessages()).items).toEqual([]);
    controller.dispose();
  });

  it("clear cancels commands and stop preserves pending commands without executing them", async () => {
    const canceled = deferred();
    const execute = vi.fn(async () => undefined);
    const { controller, settle } = fixture(execute);
    await controller.queueCommand("/toolcompact", canceled.resolve);
    await controller.abort();
    expect((await controller.pendingMessages()).items).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    await controller.clearQueue();
    await canceled.promise;
    settle();
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("clear cancels waiting commands without reporting the executing command as settled", async () => {
    const started = deferred();
    const release = deferred();
    const settled = vi.fn();
    const complete = deferred();
    const { controller, settle } = fixture(async () => {
      started.resolve();
      await release.promise;
    });
    await controller.queueCommand("/compact", () => {
      settled();
      complete.resolve();
    });
    await controller.queueCommand("/toolcompact");
    settle();
    await started.promise;
    await controller.clearQueue();
    expect(settled).not.toHaveBeenCalled();
    release.resolve();
    await complete.promise;
    expect(settled).toHaveBeenCalledTimes(1);
    expect((await controller.pendingMessages()).items).toEqual([]);
    controller.dispose();
  });

  it("explicit send-now stops the response, runs the selected command, then resumes remaining messages", async () => {
    const started = deferred();
    const release = deferred();
    const delivered = deferred();
    const { controller, session } = fixture(async () => {
      started.resolve();
      await release.promise;
    });
    await controller.queueCommand("/compact");
    await controller.prompt("After command", "follow-up", []);
    const partId = (await controller.pendingMessages()).items[0]!.partId!;
    vi.mocked(session.prompt).mockImplementation(async () => {
      delivered.resolve();
    });
    const sending = controller.sendQueuedMessageNow(partId);
    await started.promise;
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.prompt).not.toHaveBeenCalled();
    release.resolve();
    await sending;
    await delivered.promise;
    expect(vi.mocked(session.prompt).mock.calls[0]?.[0]).toContain("After command");
    controller.dispose();
  });

  it("does not start a second command after stop interrupts a running command", async () => {
    const started = deferred();
    const released = deferred();
    const settled = deferred();
    const execute = vi.fn(async () => {
      started.resolve();
      await released.promise;
    });
    const { controller, settle, session } = fixture(execute);
    await controller.queueCommand("/compact", settled.resolve);
    await controller.queueCommand("/toolcompact");
    settle();
    await started.promise;
    vi.mocked(session.abort).mockImplementation(async () => {
      released.resolve();
    });
    await controller.abort();
    await settled.promise;
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await controller.pendingMessages()).items.map(({ text }) => text)).toEqual([
      "/toolcompact",
    ]);
    controller.dispose();
  });
});
