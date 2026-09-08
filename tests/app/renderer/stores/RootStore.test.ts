import { applySnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { mountRootStore } from "../../../../src/renderer/bootstrap/mount-root-store";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";

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

describe("RootStore session navigation", () => {
  it("opens projected family children in one reusable pane", async () => {
    const models = RootProjection.create();
    applySnapshot(models.sessionCatalog, {
      sessions: [sessionSummary("parent", projectPath)],
      resolvedHasMoreByProject: {},
    });
    const open = vi.fn(async () => undefined);
    const respondControl = vi.fn(async () => undefined);
    const client = {
      projectSessions: { open, respondControl },
    } as unknown as Client;
    const root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);

    try {
      root.sessionRegistry.load("parent", projectPath);
      root.sessionLayoutStore.ensureSession("parent");
      root.appShellStore.selectProjectSession("parent");
      root.projectWorkbenchStore.showLoadedSession("parent");

      await root.respondProjectSessionControl({
        sessionId: "parent",
        controlRequestId: "00000000-0000-4000-8000-000000000000",
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: "background-child",
          title: "Background child",
          familyId: "family",
          familyChildOrder: 0,
          placement: "none",
        },
      });
      expect(root.sessionCatalogStore.find("background-child")).toMatchObject({
        title: "Background child",
        pending: true,
      });
      expect(root.sessionLayoutStore.panes.map((pane) => pane.sessionId)).toEqual(["parent"]);
      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "parent",
      });

      await root.respondProjectSessionControl({
        sessionId: "parent",
        controlRequestId: "00000000-0000-4000-8000-000000000001",
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: "child-1",
          title: "First child",
          familyId: "family",
          familyChildOrder: 0,
          placement: "right",
        },
      });
      const childPaneId = root.sessionLayoutStore.paneForSession("child-1")?.paneId;
      expect(root.sessionCatalogStore.find("child-1")).toMatchObject({
        title: "First child",
        pending: true,
        familyParentSessionId: "parent",
      });
      expect(root.sessionLayoutStore.panes).toHaveLength(2);
      expect(root.appShellStore.activeConversation).toEqual({
        kind: "project-session",
        sessionId: "child-1",
      });

      await root.respondProjectSessionControl({
        sessionId: "parent",
        controlRequestId: "00000000-0000-4000-8000-000000000002",
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: "child-2",
          title: "Second child",
          familyId: "family",
          familyChildOrder: 1,
          placement: "right",
        },
      });
      expect(root.sessionLayoutStore.paneForSession("child-2")?.paneId).toBe(childPaneId);
      expect(root.sessionLayoutStore.hasSession("child-1")).toBe(false);
      expect(root.sessionLayoutStore.panes).toHaveLength(2);
      expect(open).toHaveBeenCalledTimes(3);
      expect(respondControl).toHaveBeenCalledTimes(3);
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("closes the selected Kanban board when its navigation icon is invoked again", () => {
    const models = RootProjection.create();
    applySnapshot(models.projects, {
      projects: [
        {
          path: projectPath,
          name: "Example",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const root = mountRootStore(
      {} as Client,
      { state: {}, children: {} },
      async () => undefined,
      models,
    );
    const returnToWorkbench = vi.spyOn(root, "returnToWorkbench").mockImplementation(() => {
      root.appShellStore.showWorkbench();
    });

    try {
      root.showKanban(projectPath);
      expect(root.appShellStore.surface).toBe("kanban");

      root.showKanban(projectPath);
      expect(returnToWorkbench).toHaveBeenCalledOnce();
      expect(root.appShellStore.surface).toBe("workbench");
    } finally {
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    }
  });

  it("does not replace a session selected while worktree resolution is in flight", async () => {
    const models = RootProjection.create();
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
    } as unknown as Client;
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
