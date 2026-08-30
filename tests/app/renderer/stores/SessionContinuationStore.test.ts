import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionContinuationStore } from "../../../../src/renderer/stores/SessionContinuationStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

function createContinuation(
  options: {
    sessionContext?: () => { sessionId: string; workspacePath: string } | undefined;
    handoffTimeoutMs?: number;
  } = {},
) {
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const reportError = vi.fn();
  const handoffSession = vi.fn<DesktopClient["handoffSession"]>(async () => undefined);
  const store = mount(
    createStore(SessionContinuationStore, {
      client: {
        forkSession: vi.fn(async () => undefined),
        forkSessionToWorkspace: vi.fn(async () => ({ sessionId: "forked" })),
        handoffSession,
        loadSession: vi.fn(async () => undefined),
      },
      operations,
      registry: {} as SessionRegistryStore,
      createWorktree: vi.fn(async () => "/project-worktree"),
      sessionContext:
        options.sessionContext ?? (() => ({ sessionId: "session-1", workspacePath: "/project" })),
      sessionTitle: () => "Session",
      closeCommandPane: vi.fn(),
      openSession: vi.fn(async () => undefined),
      reportError,
      handoffTimeoutMs: options.handoffTimeoutMs,
    }),
  );
  return { store, operations, reportError, handoffSession };
}

function dispose(harness: ReturnType<typeof createContinuation>) {
  harness.store[Symbol.dispose]();
  harness.operations[Symbol.dispose]();
}

afterEach(() => vi.useRealTimers());

describe("SessionContinuationStore", () => {
  it("reports why a handoff cannot start", async () => {
    const noSession = createContinuation({ sessionContext: () => undefined });

    await expect(noSession.store.handoffAt("assistant-entry")).resolves.toBe(false);
    expect(noSession.reportError).toHaveBeenCalledWith("There is no active session to hand off");
    dispose(noSession);

    const active = createContinuation();
    await expect(active.store.handoffAt("assistant-entry")).resolves.toBe(true);
    await expect(active.store.handoffAt("assistant-entry")).resolves.toBe(false);
    expect(active.reportError).toHaveBeenCalledWith(
      "A session fork or handoff is already in progress",
    );
    expect(active.handoffSession).toHaveBeenCalledOnce();
    dispose(active);
  });

  it("times out a stuck handoff, reports the failure, and permits a retry", async () => {
    vi.useFakeTimers();
    const harness = createContinuation({ handoffTimeoutMs: 100 });

    await expect(harness.store.handoffAt("assistant-entry")).resolves.toBe(true);
    expect(harness.operations.active()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(100);

    expect(harness.reportError).toHaveBeenCalledWith("Session handoff timed out. Please try again");
    expect(harness.operations.active()).toEqual([]);
    await expect(harness.store.handoffAt("assistant-entry")).resolves.toBe(true);
    expect(harness.handoffSession).toHaveBeenCalledTimes(2);
    dispose(harness);
  });

  it("cancels the watchdog when the correlated operation completes", async () => {
    vi.useFakeTimers();
    const harness = createContinuation({ handoffTimeoutMs: 100 });

    await harness.store.handoffAt("assistant-entry");
    const operationId = harness.operations.active()[0]!;
    expect(harness.store.receive({ type: "operation-completed", operationId })).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.reportError).not.toHaveBeenCalled();
    expect(harness.operations.active()).toEqual([]);
    dispose(harness);
  });
});
