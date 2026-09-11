import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createCakeRuntimeTurnController } from "../../../../src/services/pi/runtime/cake-runtime-turn-controller";
import { projectQueuedMessages } from "../../../../src/services/pi/runtime/session-projection";

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

  describe("per-item edits of Pi's queue", () => {
    const partIds = (steering: string[], followUp: string[], pending: string[] = []) =>
      projectQueuedMessages(steering, followUp, pending).map((part) => part.id);

    function createQueuedFixture(queue: { steering: string[]; followUp: string[] }) {
      const live = { steering: [...queue.steering], followUp: [...queue.followUp] };
      return createFixture({
        isStreaming: true,
        prompt: vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
          if (options?.streamingBehavior === "steer") live.steering.push(text);
          else live.followUp.push(text);
        }),
        getSteeringMessages: vi.fn(() => live.steering),
        getFollowUpMessages: vi.fn(() => live.followUp),
        clearQueue: vi.fn(() => {
          const cleared = { steering: [...live.steering], followUp: [...live.followUp] };
          live.steering = [];
          live.followUp = [];
          return cleared;
        }),
      });
    }

    it("removes one held follow-up, re-queues the rest in order, and cancels its correlation", async () => {
      const { controller, session, syncQueuedParts } = createQueuedFixture({
        steering: ["Change direction"],
        followUp: ["Do this next"],
      });
      const tracked = controller.prompt("Then this", "follow-up", [], false, "turn-then");
      const [, , thenThisId] = partIds(["Change direction"], ["Do this next", "Then this"]);

      await expect(controller.removeQueuedMessage(thenThisId!)).resolves.toEqual({
        steering: ["Change direction"],
        followUp: ["Do this next"],
      });

      await expect(tracked).rejects.toThrow("Queued input was canceled");
      expect(session.clearQueue).toHaveBeenCalledOnce();
      expect(
        vi.mocked(session.prompt).mock.calls.map(([text, options]) => [text, options]),
      ).toEqual([
        ["Then this", expect.objectContaining({ streamingBehavior: "followUp" })],
        ["Change direction", expect.objectContaining({ streamingBehavior: "steer" })],
        ["Do this next", expect.objectContaining({ streamingBehavior: "followUp" })],
      ]);
      expect(syncQueuedParts).toHaveBeenCalled();
    });

    it("promotes one held follow-up to steering without touching other correlations", async () => {
      const { controller, session } = createQueuedFixture({ steering: [], followUp: [] });
      const tracked = controller.prompt("Do this next", "follow-up", [], false, "turn-next");
      await controller.prompt("Then this", "follow-up", []);
      const [doThisNextId] = partIds([], ["Do this next", "Then this"]);

      await expect(controller.steerQueuedMessage(doThisNextId!)).resolves.toEqual({
        steering: ["Do this next"],
        followUp: ["Then this"],
      });

      expect(vi.mocked(session.prompt).mock.calls.slice(2)).toEqual([
        ["Do this next", expect.objectContaining({ streamingBehavior: "steer" })],
        ["Then this", expect.objectContaining({ streamingBehavior: "followUp" })],
      ]);
      controller.consumeUserMessage("Do this next");
      controller.settleTurn();
      await expect(tracked).resolves.toBeUndefined();
    });

    it("leaves the queue untouched for an unknown part id", async () => {
      const { controller, session } = createQueuedFixture({
        steering: [],
        followUp: ["Do this next"],
      });

      await expect(controller.removeQueuedMessage("queued-follow-up-missing-1")).resolves.toEqual({
        steering: [],
        followUp: ["Do this next"],
      });
      expect(session.clearQueue).not.toHaveBeenCalled();
      expect(session.prompt).not.toHaveBeenCalled();
    });

    it("edits compaction-held input in place", async () => {
      const { controller, session } = createFixture({ isStreaming: true, isCompacting: true });
      const removed = controller.prompt("Drop me", "prompt", [], false, "turn-drop");
      await controller.prompt("Steer me", "prompt", []);
      const [dropId, steerId] = partIds([], [], ["Drop me", "Steer me"]);

      await expect(controller.removeQueuedMessage(dropId!)).resolves.toEqual({
        steering: [],
        followUp: ["Steer me"],
      });
      await expect(removed).rejects.toThrow("Queued input was canceled");

      await expect(controller.steerQueuedMessage(steerId!)).resolves.toEqual({
        steering: ["Steer me"],
        followUp: [],
      });
      expect(session.clearQueue).not.toHaveBeenCalled();
    });
  });
});
