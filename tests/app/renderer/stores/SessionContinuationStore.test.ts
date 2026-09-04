import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { SessionContinuationStore } from "../../../../src/renderer/stores/SessionContinuationStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

const disposables: Array<{ [Symbol.dispose](): void }> = [];

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable[Symbol.dispose]();
});

function setup(options?: { workspacePath?: string; canBranch?: boolean }) {
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const createWorktree = vi.fn(async () => "/created-worktree");
  const openSession = vi.fn(async () => undefined);
  const fork = vi.fn(async () => ({ sessionId: "forked" }));
  const handoff = vi.fn(async () => ({ sessionId: "handed-off" }));
  const { root, subject } = mountWithRendererClient(
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
    { projectSessions: { fork, handoff } } as unknown as RendererClient,
  );
  disposables.push(root, operations);
  return { store: subject, createWorktree, openSession, fork, handoff };
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

  it("hands off into a child worktree and can resolve its parent", async () => {
    const { store, createWorktree, openSession, handoff } = setup();
    await store.handoffAt("assistant-entry", "Continue cleanly", true);
    store.selectDestination("branch-worktree");
    store.setWorktreeName("continued-child");

    await store.confirmPrompt();

    expect(createWorktree).toHaveBeenCalledWith("/project", "continued-child", "/current-worktree");
    expect(handoff).toHaveBeenCalledWith(
      {
        sessionId: "source",
        workingDirectory: "/current-worktree",
        entryId: "assistant-entry",
        resolveSource: true,
        destinationWorkingDirectory: "/created-worktree",
        prompt: "Continue cleanly",
      },
      expect.any(Object),
    );
    expect(openSession).toHaveBeenCalledWith("handed-off", "/created-worktree");
  });

  it("does not select child-worktree branching outside a managed worktree", () => {
    const { store } = setup({ canBranch: false });
    store.forkAt("assistant-entry");

    store.selectDestination("branch-worktree");

    expect(store.prompt?.destination).toBe("existing");
  });
});
