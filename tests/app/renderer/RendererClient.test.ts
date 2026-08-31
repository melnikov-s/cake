import { describe, expect, it, vi } from "vitest";
import { makeRendererClient } from "../../../src/renderer/client/RendererClientLive";
import { RendererClientError } from "../../../src/renderer/client/RendererClient";
import type { RendererRuntime } from "../../../src/renderer/RendererRuntime";

function controlledRuntime(runPromise: RendererRuntime["runPromise"]): RendererRuntime {
  return { runPromise } as RendererRuntime;
}

describe("RendererClient", () => {
  it("exposes focused command groups without observation methods", () => {
    const runtime = controlledRuntime(
      vi.fn(async () => undefined) as RendererRuntime["runPromise"],
    );
    const client = makeRendererClient(runtime);

    expect(Object.keys(client)).toEqual([
      "application",
      "models",
      "modelPresets",
      "projectSessions",
      "cakeChats",
      "discussionSessions",
      "subagents",
      "foundation",
    ]);
    expect("observe" in client.projectSessions).toBe(false);
    expect("observe" in client.cakeChats).toBe(false);
    expect("observe" in client.discussionSessions).toBe(false);
    expect("observe" in client.subagents).toBe(false);
  });

  it("passes AbortSignal to the window runtime and reports interruption stably", async () => {
    const runPromise = vi.fn(async () => {
      throw new Error("fiber interrupted");
    }) as RendererRuntime["runPromise"];
    const client = makeRendererClient(controlledRuntime(runPromise));
    const controller = new AbortController();
    controller.abort();

    const failure = await client.foundation
      .delay({ durationMs: 10_000 }, { signal: controller.signal })
      .catch((error: unknown) => error);

    expect(runPromise).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
    expect(failure).toBeInstanceOf(RendererClientError);
    expect(failure).toMatchObject({
      _tag: "RendererClientError",
      kind: "interrupted",
      operation: "foundation.delay",
      message: "The operation was cancelled",
    });
  });

  it("does not expose arbitrary command rejection values", async () => {
    const runPromise = vi.fn(async () => {
      throw { _tag: "ModelPresetNotFoundError", id: "missing" };
    }) as RendererRuntime["runPromise"];
    const client = makeRendererClient(controlledRuntime(runPromise));

    const failure = await client.modelPresets.resolve("missing").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RendererClientError);
    expect(failure).toMatchObject({
      kind: "rejected",
      operation: "modelPresets.resolve",
    });
  });
});
