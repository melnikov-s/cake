import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { SessionContinuationStore } from "../../../../src/renderer/stores/SessionContinuationStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithClient } from "../mount-with-client";

const disposables: Array<{ [Symbol.dispose](): void }> = [];

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable[Symbol.dispose]();
});

function setup(options?: {
  workspacePath?: string;
  canBranch?: boolean;
  createWorktree?: () => Promise<string>;
}) {
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const createWorktree = vi.fn(options?.createWorktree ?? (async () => "/created-worktree"));
  const openSession = vi.fn(async () => undefined);
  const fork = vi.fn(async () => ({ sessionId: "forked" }));
  const toolCompact = vi.fn(async () => ({ sessionId: "source" }));
  const { root, subject } = mountWithClient(
    createStore(SessionContinuationStore, {
      operations,
      createWorktree,
      sessionContext: () => ({
        sessionId: "source",
        projectPath: "/project",
        workspacePath: options?.workspacePath ?? "/current-worktree",
        canBranchFromCurrentWorktree: options?.canBranch ?? true,
      }),
      sessionTitle: () => "Continue work",
      closeCommandPane: vi.fn(),
      openSession,
      reportError: vi.fn(),
    }),
    { projectSessions: { fork, toolCompact } } as unknown as Client,
  );
  disposables.push(root, operations);
  return { store: subject, createWorktree, openSession, fork, toolCompact };
}

describe("SessionContinuationStore", () => {
  it("forks into the project root without creating a worktree", async () => {
    const { store, createWorktree, openSession, fork } = setup();
    store.forkAt("assistant-entry");
    store.selectDestination("project-root");

    await store.confirmPrompt();

    expect(createWorktree).not.toHaveBeenCalled();
    expect(fork).toHaveBeenCalledWith(
      {
        sessionId: "source",
        workingDirectory: "/current-worktree",
        entryId: "assistant-entry",
        resolveSource: false,
        destinationWorkingDirectory: "/project",
      },
      expect.any(Object),
    );
    expect(openSession).toHaveBeenCalledWith("forked", "/project");
  });

  it("tool-compacts the current session without opening a continuation dialog", async () => {
    const { store, createWorktree, openSession, toolCompact } = setup();

    const result = await store.toolCompactAt("assistant-entry", "Continue cleanly");

    expect(result).toBe(true);
    expect(store.prompt).toBeUndefined();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(toolCompact).toHaveBeenCalledWith(
      {
        sessionId: "source",
        workingDirectory: "/current-worktree",
        entryId: "assistant-entry",
        prompt: "Continue cleanly",
      },
      expect.any(Object),
    );
  });

  it("does not expose a full-screen preparation state while worktree creation is running", async () => {
    let finishWorktree: ((path: string) => void) | undefined;
    const worktree = new Promise<string>((resolve) => {
      finishWorktree = resolve;
    });
    const { store, fork, openSession } = setup({ createWorktree: () => worktree });
    store.forkAt("assistant-entry");
    store.selectDestination("new-worktree");

    const confirmation = store.confirmPrompt();

    expect(store.prompt).toBeUndefined();
    expect("preparation" in store).toBe(false);
    expect(fork).not.toHaveBeenCalled();

    finishWorktree?.("/created-worktree");
    await confirmation;

    expect(openSession).toHaveBeenCalledWith("forked", "/created-worktree");
  });

  it("does not select child-worktree branching outside a managed worktree", () => {
    const { store } = setup({ canBranch: false });
    store.forkAt("assistant-entry");

    store.selectDestination("branch-worktree");

    expect(store.prompt?.destination).toBe("existing");
  });
});
