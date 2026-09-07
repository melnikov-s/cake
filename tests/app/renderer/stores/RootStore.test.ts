import { applySnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { mountRootStore } from "../../../../src/renderer/mount-root-store";
import { RendererModels } from "../../../../src/renderer/RendererModels";

const projectPath = "/projects/example";
const worktreePath = "/projects/.cake-worktrees/example-task";

const sessionSummary = (sessionId: string, workingDirectory: string) => ({
  sessionId,
  title: sessionId,
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  resolved: false,
  unread: false,
  projectPath,
  projectName: "Example",
  workingDirectory,
  pending: false,
  draft: false,
});

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((complete) => (resolve = complete)),
    resolve,
  };
}

describe("RootStore resolved-session navigation", () => {
  it("does not replace a session selected while worktree resolution is in flight", async () => {
    const models = new RendererModels();
    applySnapshot(models.sessionCatalog, {
      sessions: [
        sessionSummary("worktree-session", worktreePath),
        sessionSummary("current-session", projectPath),
      ],
      resolvedHasMoreByProject: {},
    });
    const resolution = deferred();
    const client = {
      projectSessions: { resolve: vi.fn(() => resolution.promise) },
    } as unknown as RendererClient;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);
    const createSession = vi.spyOn(root, "createSession").mockResolvedValue(undefined);

    try {
      root.appShellStore.selectProjectSession("worktree-session");
      const resolving = root.projectWorkbenchStore.resolveWorktreeWorkspace(worktreePath, {
        workingDirectoryRetired: true,
      });
      root.appShellStore.selectProjectSession("current-session");

      resolution.resolve();
      await resolving;

      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "current-session",
      });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });
});
