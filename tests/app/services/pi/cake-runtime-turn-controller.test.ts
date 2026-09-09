import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createCakeRuntimeTurnController } from "../../../../src/services/pi/runtime/cake-runtime-turn-controller";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFixture(overrides: Partial<AgentSession> = {}) {
  const session = {
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    executeBash: vi.fn(async () => ({ exitCode: 0, cancelled: false })),
    abortBash: vi.fn(),
    abort: vi.fn(async () => undefined),
    getSteeringMessages: vi.fn(() => []),
    getFollowUpMessages: vi.fn(() => []),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    ...overrides,
  } as unknown as AgentSession;
  const syncQueuedParts = vi.fn();
  const controller = createCakeRuntimeTurnController({
    session,
    isDisposed: () => false,
    beforeIdleTurn: async () => undefined,
    withResponseRetries: (operation) => operation(),
    cancelResponseRetries: vi.fn(),
    recovery: { onUserInput: vi.fn(), onAbort: vi.fn() },
    deliverTrackedUserMessage: (_content, _markdown, deliver) => deliver(),
    syncQueuedParts,
    emitPart: vi.fn(),
    emitSnapshot: async () => undefined,
    emitSnapshotInBackground: vi.fn(),
  });
  return { controller, session, syncQueuedParts };
}

describe("CakeRuntime turn controller", () => {
  it("does not dispatch an accepted idle prompt after abort wins during preparation", async () => {
    const preparation = deferred();
    const { controller, session } = createFixture();
    const preparedController = createCakeRuntimeTurnController({
      session,
      isDisposed: () => false,
      beforeIdleTurn: () => preparation.promise,
      withResponseRetries: (operation) => operation(),
      cancelResponseRetries: vi.fn(),
      recovery: { onUserInput: vi.fn(), onAbort: vi.fn() },
      deliverTrackedUserMessage: (_content, _markdown, deliver) => deliver(),
      syncQueuedParts: vi.fn(),
      emitPart: vi.fn(),
      emitSnapshot: async () => undefined,
      emitSnapshotInBackground: vi.fn(),
    });

    const prompt = preparedController.prompt("Do work", "prompt", [], false, "turn-1");
    await preparedController.abort();
    preparation.resolve();

    await expect(prompt).rejects.toThrow("Session was aborted");
    expect(session.prompt).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("keeps later compaction-held input visible and clearable while the first item runs", async () => {
    const delivery = deferred();
    const prompt = vi.fn(() => delivery.promise);
    const { controller, session } = createFixture({
      isStreaming: true,
      isCompacting: true,
      prompt,
    });

    await controller.prompt("First", "prompt", []);
    await controller.prompt("Second", "prompt", []);
    Object.assign(session, { isStreaming: false, isCompacting: false });
    controller.compactionEnded(false);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

    expect(await controller.listQueuedMessages()).toEqual({
      steering: [],
      followUp: ["Second"],
    });
    await expect(controller.clearQueue()).resolves.toEqual({
      steering: [],
      followUp: ["Second"],
    });
    delivery.resolve();
    await Promise.resolve();
    expect(session.followUp).not.toHaveBeenCalled();
  });

  it("rejects a correlated compaction-held turn when detached delivery fails", async () => {
    const { controller, session } = createFixture({
      isStreaming: true,
      isCompacting: true,
      prompt: vi.fn(async () => {
        throw new Error("delivery failed");
      }),
    });

    const accepted = controller.prompt("Do work", "prompt", [], false, "turn-1");
    Object.assign(session, { isStreaming: false, isCompacting: false });
    controller.compactionEnded(false);

    await expect(accepted).rejects.toThrow("delivery failed");
    expect(controller.executingTurnIds()).toEqual([]);
  });

  it("drops compaction-held input when the session is aborted", async () => {
    const { controller, session, syncQueuedParts } = createFixture({
      isStreaming: true,
      isCompacting: true,
    });

    const prompt = controller.prompt("Do work later", "prompt", [], false, "turn-1");
    await controller.abort();
    await expect(prompt).rejects.toThrow("Session was aborted");

    Object.assign(session, { isStreaming: false, isCompacting: false });
    controller.compactionEnded(false);
    await Promise.resolve();

    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.followUp).not.toHaveBeenCalled();
    expect(controller.compactionQueuedMessages()).toEqual([]);
    expect(syncQueuedParts).toHaveBeenCalledTimes(2);
  });
});
