import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import * as agentPolicy from "../../../../src/domain/project-sessions/projectSessionAgentPolicy";
import {
  ResolutionCleanupFailed,
  ResolutionRejected,
} from "../../../../src/contracts/project-sessions/project-session-resolution";
import {
  SessionFamilyStorage,
  type SessionFamily,
} from "../../../../src/services/storage/SessionFamilyStorage";
import { makePiCallbackExecutor } from "../../../../src/services/pi/PiCallbackAdapter";
import { describe, expect, it, vi } from "vitest";
import type {
  CakeSessionRuntimeOptions,
  ProjectSessionLivePolicyControl,
} from "../../../../src/services/pi/runtime/cake-session-runtime";
import { createCakeSessionRuntimeContinuations } from "../../../../src/services/pi/runtime/cake-session-runtime-continuations";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture(overrides: Partial<CakeSessionRuntimeOptions> = {}) {
  const sessionManager = SessionManager.inMemory("/project");
  const emitSnapshot = vi.fn(async () => undefined);
  const emitNotice = vi.fn();
  const reportAgentAction = vi.fn(async () => undefined);
  let streaming = true;
  const continuations = createCakeSessionRuntimeContinuations({
    options: {
      cwd: "/project",
      agentDir: "/agent",
      sessionDir: "/sessions",
      trusted: true,
      requestUi: async () => undefined,
      onEvent: () => undefined,
      utilityModel: () => ({ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" }),
      ...overrides,
    },
    session: {
      sessionManager,
      setSessionName: (name) => {
        sessionManager.appendSessionInfo(name);
      },
      sessionFile: undefined,
      get isStreaming() {
        return streaming;
      },
      navigateTree: async () => ({ cancelled: false }),
      model: undefined,
      thinkingLevel: "off",
    },
    sessionId: sessionManager.getSessionId(),
    isDisposed: () => disposed,
    emitSnapshot,
    emitNotice,
    drainReloads: () => undefined,
    handleSettledTurn: async () => undefined,
    reportAgentAction,
  });
  let disposed = false;
  return {
    continuations,
    sessionManager,
    emitSnapshot,
    emitNotice,
    reportAgentAction,
    settle() {
      streaming = false;
    },
    dispose() {
      disposed = true;
      continuations.dispose();
    },
  };
}

const standaloneControl = (): NonNullable<CakeSessionRuntimeOptions["currentSessionControl"]> => ({
  resolved: () => false,
  setResolved: vi.fn(async () => undefined),
  readPolicy: vi.fn<ProjectSessionLivePolicyControl["readPolicy"]>(async () => ({
    canFork: true,
    deferResolution: true,
  })),
  resolveDeferredStandalone: vi.fn<ProjectSessionLivePolicyControl["resolveDeferredStandalone"]>(
    async () => undefined,
  ),
});

const promotedFamily: SessionFamily = {
  familyId: "family",
  parentSessionId: "root",
  projectPath: "/project",
  workingDirectory: "/project",
  createdAt: "2026-01-01T00:00:00.000Z",
  children: [
    {
      sessionId: "child",
      parentSessionId: "root",
      workingDirectory: "/project",
      requestId: "create-child",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("live Project Session continuation policy", () => {
  it("checks current policy before scheduling a fork and again before executing it", async () => {
    const state: { family?: SessionFamily } = {};
    const storage = Layer.mock(SessionFamilyStorage, {
      familyForMember: () => Effect.succeed(state.family),
    });
    const execute = vi.fn(async () => ({ sessionId: "fork" }));
    const control = {
      ...standaloneControl(),
      readPolicy: () => Effect.runPromise(agentPolicy.read("root").pipe(Effect.provide(storage))),
      // The same domain guard used by runtime assembly; its real callback is
      // also covered by projectSessionAgentPolicy.test.ts with real family storage.
      forkSession: async () => {
        await Effect.runPromise(agentPolicy.assertCanFork("root").pipe(Effect.provide(storage)));
        return execute();
      },
    };
    const f = fixture({ currentSessionControl: control });
    const pending = { entryId: "entry", resolveSource: false, placement: "none" as const };
    expect(await f.continuations.scheduleFork(pending)).toMatchObject({ forkOnSettle: true });
    state.family = promotedFamily;
    f.settle();
    await f.continuations.finishSettledTurn();
    expect(execute).not.toHaveBeenCalled();
    expect(f.emitNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: "Could not fork session",
        detail: "Session Family members cannot be forked by their agent",
      }),
    );
    await expect(f.continuations.scheduleFork(pending)).rejects.toThrow(/Session Family/);
    await f.continuations.finishSettledTurn();
    expect(f.emitNotice).toHaveBeenCalledOnce();
  });

  it("does not defer a family resolution request in a runtime created before family promotion", async () => {
    let family = false;
    const refusal = new ResolutionRejected({
      operation: "resolve",
      sessionIds: ["root", "child"],
      message: "Family has active work",
    });
    const setResolved = vi.fn(async () => {
      throw refusal;
    });
    const control = {
      ...standaloneControl(),
      setResolved,
      readPolicy: async () => ({ canFork: !family, deferResolution: !family }),
    };
    const f = fixture({ currentSessionControl: control });
    expect((await control.readPolicy()).deferResolution).toBe(true);
    family = true;
    await expect(f.continuations.setResolved(true)).rejects.toBe(refusal);
    expect(setResolved).toHaveBeenCalledExactlyOnceWith(true);
    f.settle();
    await f.continuations.finishSettledTurn();
    expect(control.resolveDeferredStandalone).not.toHaveBeenCalled();
    expect(f.reportAgentAction).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses resolveDeferredStandalone rather than broadening a deferred request to a family (promoted=%s)",
    async (promoted) => {
      const control = standaloneControl();
      const refusal = new ResolutionRejected({
        operation: "resolveDeferredStandalone",
        sessionIds: ["root"],
        message: "Session joined a family before deferred resolution",
      });
      const guarded = vi.fn(async () => {
        if (promoted) throw refusal;
      });
      control.resolveDeferredStandalone = guarded;
      const f = fixture({ currentSessionControl: control });
      expect(await f.continuations.setResolved(true)).toMatchObject({
        resolved: false,
        resolveOnSettle: true,
      });
      await f.continuations.finishSettledTurn();
      expect(guarded).not.toHaveBeenCalled();
      f.settle();
      await f.continuations.finishSettledTurn();
      await f.continuations.finishSettledTurn();
      expect(guarded).toHaveBeenCalledOnce();
      expect(control.setResolved).not.toHaveBeenCalled();
      if (promoted) {
        expect(f.emitNotice).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            title: "Could not resolve session",
            detail: refusal.message,
          }),
        );
        expect(f.reportAgentAction).not.toHaveBeenCalled();
      } else {
        expect(f.emitNotice).not.toHaveBeenCalled();
        expect(f.reportAgentAction).toHaveBeenCalledExactlyOnceWith("resolve");
      }
    },
  );

  it.each([false, true])(
    "reports committed resolution with cleanup failure without claiming resolution failed (deferred=%s)",
    async (deferred) => {
      const committed = new ResolutionCleanupFailed({
        operation: "resolve",
        resolvedSessionIds: ["root", "child"],
        cleanupFailures: [{ workingDirectory: "/worktrees/child", message: "Checkout is busy" }],
        message: "Resolution committed; checkout cleanup failed",
      });
      const run = makePiCallbackExecutor(Context.empty());
      const resolve = vi.fn(() => run(Effect.fail(committed)));
      const control = {
        ...standaloneControl(),
        setResolved: resolve,
        resolveDeferredStandalone: resolve,
      };
      const f = fixture({ currentSessionControl: control });
      if (!deferred) f.settle();
      const result = await f.continuations.setResolved(true);
      if (deferred) {
        expect(result).toMatchObject({ resolved: false, resolveOnSettle: true });
        f.settle();
        await f.continuations.finishSettledTurn();
        expect(f.emitNotice).toHaveBeenCalledExactlyOnceWith({
          id: "session-resolution-cleanup-failed",
          kind: "notice",
          tone: "error",
          title: "Session resolved; Working Directory cleanup failed",
          detail:
            "Resolved sessions: root, child\nResolution committed; checkout cleanup failed\n/worktrees/child: Checkout is busy",
        });
      } else {
        expect(result).toEqual({
          sessionId: f.sessionManager.getSessionId(),
          resolved: true,
          resolveOnSettle: false,
          cleanupFailures: committed.cleanupFailures,
        });
        expect(f.emitNotice).not.toHaveBeenCalled();
      }
      expect(f.reportAgentAction).toHaveBeenCalledExactlyOnceWith("resolve");
      await f.continuations.finishSettledTurn();
      expect(resolve).toHaveBeenCalledOnce();
    },
  );

  it("does not reinterpret an operational resolution failure as committed", async () => {
    const failure = new Error("Storage unavailable");
    const control = {
      ...standaloneControl(),
      setResolved: vi.fn(async () => {
        throw failure;
      }),
    };
    const f = fixture({ currentSessionControl: control });
    f.settle();
    await expect(f.continuations.setResolved(true)).rejects.toBe(failure);
    expect(f.reportAgentAction).not.toHaveBeenCalled();
  });
});

describe("automatic session titles", () => {
  it("commits a late utility result while the main turn is still streaming", async () => {
    const generated = deferred<string>();
    const generateSessionTitle = vi.fn(() => generated.promise);
    const { continuations, sessionManager, emitSnapshot } = fixture({ generateSessionTitle });
    const naming = continuations.initializeSessionFromFirstMessage("Investigate naming");
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    generated.resolve("Generated title");
    await naming;
    expect(sessionManager.getSessionName()).toBe("Generated title");
    expect(emitSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps a manual name when an outstanding utility result arrives", async () => {
    const generated = deferred<string>();
    const { continuations, sessionManager } = fixture({
      generateSessionTitle: () => generated.promise,
    });
    const naming = continuations.initializeSessionFromFirstMessage("Investigate naming");
    await continuations.rename("My explicit name");
    generated.resolve("Unwanted title");
    await naming;
    expect(sessionManager.getSessionName()).toBe("My explicit name");
    await continuations.rename("Another generated title", false, true);
    expect(sessionManager.getSessionName()).toBe("My explicit name");
    await continuations.rename("A new manual name");
    expect(sessionManager.getSessionName()).toBe("A new manual name");
  });

  it("skips duplicate submission-time naming but retains labels and later unnamed-session eligibility", async () => {
    const generateSessionTitle = vi.fn(async () => "Generated title");
    const autoLabelSession = vi.fn(async () => undefined);
    const { continuations, sessionManager } = fixture({ generateSessionTitle, autoLabelSession });
    await continuations.initializeSessionFromFirstMessage("Investigate naming", false);
    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(autoLabelSession).toHaveBeenCalledOnce();
    expect(sessionManager.getSessionName()).toBeUndefined();
    await continuations.initializeSessionFromFirstMessage("Investigate naming");
    expect(generateSessionTitle).toHaveBeenCalledOnce();
    expect(sessionManager.getSessionName()).toBe("Generated title");
  });

  it("cancels naming on disposal and does not commit a result that races cancellation", async () => {
    const generated = deferred<string>();
    let signal: AbortSignal | undefined;
    const current = fixture({
      generateSessionTitle: async (input) => {
        signal = input.signal;
        return generated.promise;
      },
    });
    const naming = current.continuations.initializeSessionFromFirstMessage("Investigate naming");
    current.dispose();
    expect(signal?.aborted).toBe(true);
    generated.resolve("Discarded title");
    await naming;
    expect(current.sessionManager.getSessionName()).toBeUndefined();
    expect(current.emitSnapshot).not.toHaveBeenCalled();
  });
});
