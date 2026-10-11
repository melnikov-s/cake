import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CakeSessionRuntimeOptions } from "../../../../src/services/pi/runtime/cake-session-runtime";
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
      isStreaming: true,
      navigateTree: async () => ({ cancelled: false }),
      model: undefined,
      thinkingLevel: "off",
    },
    sessionId: sessionManager.getSessionId(),
    isDisposed: () => disposed,
    emitSnapshot,
    emitNotice: () => undefined,
    drainReloads: () => undefined,
    handleSettledTurn: async () => undefined,
    reportAgentAction: async () => undefined,
  });
  let disposed = false;
  return {
    continuations,
    sessionManager,
    emitSnapshot,
    dispose() {
      disposed = true;
      continuations.dispose();
    },
  };
}

describe("live Project Session continuation policy", () => {
  // Review stubs: exercise the real continuation adapter with controlled policy callbacks.
  it.todo("checks current policy before scheduling a fork and again before executing it");
  it.todo(
    "does not defer a family resolution request in a runtime created before family promotion",
  );
  it.todo("uses resolveDeferredStandalone rather than broadening a deferred request to a family");
  it.todo("reports committed resolution with cleanup failure without claiming resolution failed");
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
