import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import type { ExtensionUiStore } from "../../../../src/renderer/stores/ExtensionUiStore";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import { ProjectWorkbenchStore } from "../../../../src/renderer/stores/ProjectWorkbenchStore";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithClient } from "../mount-with-client";

function mountWorkbench(
  registry: SessionRegistryStore,
  catalog: SessionCatalogStore,
  client: Client,
  initialActiveSessionId?: string,
  restoreStagedSession?: (projectPath: string) => string | undefined,
  workflow?: {
    prepareWorkingDirectoryRetirement?(workingDirectories: readonly string[]): Promise<boolean>;
    onWorktreeSessionsResolved?(sessionIds: readonly string[], projectPath: string): Promise<void>;
  },
) {
  let activeSessionId = initialActiveSessionId;
  const selectSession = vi.fn((sessionId: string) => {
    activeSessionId = sessionId;
  });
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const mounted = mountWithClient(
    createStore(ProjectWorkbenchStore, {
      prepareWorkingDirectoryRetirement:
        workflow?.prepareWorkingDirectoryRetirement ?? (async () => true),
      sessionRegistry: registry,
      operations,
      projects: {} as ProjectCatalogStore,
      reviews: () => ({}) as ReviewsStore,
      extensionUi: () => ({ clear: vi.fn() }) as unknown as ExtensionUiStore,
      catalog,
      startCakeChat: async () => undefined,
      onWorktreeSessionsResolved: workflow?.onWorktreeSessionsResolved ?? (async () => undefined),
      openSessionById: async () => undefined,
      activeSessionId: () => activeSessionId,
      restoreStagedSession,
      selectSession,
      toggleProjectSidebar: vi.fn(),
      enterIdeSidebarMode: vi.fn(),
      leaveIdeSidebarMode: vi.fn(),
      projectSidebarWidth: () => 292,
    }),
    client,
  );
  return { ...mounted, operations, selectSession };
}

describe("ProjectWorkbenchStore cleanup workflows", () => {
  it("confirms authoritative bulk cleanup candidates and delegates one semantic command", async () => {
    const prepare = vi.fn(async () => true);
    const inspectResolvedForProject = vi.fn(async () => ({
      projectPath: "/project",
      workingDirectories: ["/eligible"],
    }));
    const discardResolvedForProject = vi.fn(async () => ({
      projectPath: "/project",
      discardedWorkingDirectories: ["/eligible"],
      failures: [],
    }));
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(
      {} as SessionRegistryStore,
      {
        resolvedWorktrees: vi.fn(() => [{ worktreePath: "/stale-renderer-choice" }]),
      } as unknown as SessionCatalogStore,
      {
        managedWorktrees: { inspectResolvedForProject, discardResolvedForProject },
      } as unknown as Client,
      undefined,
      undefined,
      { prepareWorkingDirectoryRetirement: prepare },
    );

    await expect(store.deleteResolvedWorktrees("/project")).resolves.toBe(true);

    expect(inspectResolvedForProject).toHaveBeenCalledWith("/project", expect.any(Object));
    expect(prepare).toHaveBeenCalledWith(["/eligible"]);
    expect(discardResolvedForProject).toHaveBeenCalledWith("/project", expect.any(Object));

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("uses the main-selected Working Directory result for renderer cleanup", async () => {
    const prepare = vi.fn(async () => true);
    const onResolved = vi.fn(async () => undefined);
    const resolveWorkingDirectory = vi.fn(async () => ({
      projectPath: "/project",
      workingDirectory: "/worktree",
      resolvedSessionIds: ["session-1", "session-2"],
      failures: [],
    }));
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(
      {} as SessionRegistryStore,
      { sessions: [] } as unknown as SessionCatalogStore,
      { projectSessions: { resolveWorkingDirectory } } as unknown as Client,
      undefined,
      undefined,
      {
        prepareWorkingDirectoryRetirement: prepare,
        onWorktreeSessionsResolved: onResolved,
      },
    );

    await store.resolveWorktreeWorkspace("/worktree");

    expect(prepare).toHaveBeenCalledWith(["/worktree"]);
    expect(resolveWorkingDirectory).toHaveBeenCalledWith(
      { workingDirectory: "/worktree" },
      expect.any(Object),
    );
    expect(onResolved).toHaveBeenCalledWith(["session-1", "session-2"], "/project");

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});

describe("ProjectWorkbenchStore startup selection", () => {
  it("selects a cached session immediately without reopening it", async () => {
    const open = vi.fn(async () => undefined);
    const session = {
      workspacePath: "/project",
      model: { sessionId: "session-1" },
      ideMode: false,
      markRead: vi.fn(),
    };
    const registry = {
      findSession: (sessionId: string) => (sessionId === "session-1" ? session : undefined),
      pendingSessions: { isTemporary: () => false },
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) =>
        sessionId === "session-1"
          ? { sessionId, workingDirectory: "/project", unread: false }
          : undefined,
    } as SessionCatalogStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      catalog,
      { projectSessions: { open } } as unknown as Client,
      "session-1",
    );
    store.projectPath = "/project";

    await store.openSession("session-1");

    expect(selectSession).toHaveBeenCalledWith("session-1");
    expect(store.activeSessionId).toBe("session-1");
    expect(open).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("hydrates its runtime view from the shell selection without persisting another selection", async () => {
    const inspect = vi.fn(async (input: { operationId: string; path: string }) => ({
      ...input,
      trustRequired: true,
    }));
    const load = vi.fn();
    const registry = {
      findSession: () => undefined,
      load,
      pendingSessions: { isTemporary: () => false, isDraft: () => false },
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      { workspaces: { inspect } } as unknown as Client,
      "session-1",
    );

    await store.initialize({ workspacePath: "/project", sessionId: "session-1" });

    expect(store.projectPath).toBe("/project");
    expect(store.activeSessionId).toBe("session-1");
    expect(load).toHaveBeenCalledWith("session-1", "/project");
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
      expect.any(Object),
    );
    expect(toSnapshot(store).state).not.toHaveProperty("selectedSessionId");
    expect(selectSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("selects an uncached session before its open request finishes", async () => {
    let finishOpen: (() => void) | undefined;
    const open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );
    const registry = {
      findSession: () => undefined,
      load: vi.fn(),
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) => ({
        sessionId,
        workingDirectory: "/project",
        unread: false,
      }),
    } as SessionCatalogStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(registry, catalog, {
      projectSessions: { open },
    } as unknown as Client);

    const opening = store.openSession("session-1");

    expect(selectSession).toHaveBeenCalledWith("session-1");
    expect(store.activeSessionId).toBe("session-1");
    expect(open).toHaveBeenCalled();

    finishOpen?.();
    await opening;
    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("restores the focused pane's staged composer when starting a new session", async () => {
    const stagedSession = { sessionId: "staged-1", workspacePath: "/project" };
    const registry = {
      findSession: (sessionId: string) =>
        sessionId === stagedSession.sessionId ? stagedSession : undefined,
      pendingSessions: { isStaged: () => false },
    } as unknown as SessionRegistryStore;
    const restoreStagedSession = vi.fn(() => stagedSession.sessionId);
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      {} as Client,
      undefined,
      restoreStagedSession,
    );
    const showLoadedSession = vi.spyOn(store, "showLoadedSession").mockReturnValue(true);

    await store.startNewSession("/project");

    expect(restoreStagedSession).toHaveBeenCalledWith("/project");
    expect(selectSession).toHaveBeenCalledWith(stagedSession.sessionId);
    expect(showLoadedSession).toHaveBeenCalledWith(stagedSession.sessionId);

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("opens a new session from the workspace inspection response", async () => {
    const inspect = vi.fn(async (input: { operationId: string; path: string }) => ({
      ...input,
      trustRequired: false,
    }));
    const registry = {
      findSession: () => undefined,
      isStagedSession: () => false,
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      { workspaces: { inspect } } as unknown as Client,
    );
    const showTemporarySession = vi
      .spyOn(
        store as unknown as {
          showTemporarySession: (path: string, sessionId: string, staged?: boolean) => void;
        },
        "showTemporarySession",
      )
      .mockImplementation(() => undefined);

    await store.startNewSession("/other-project");

    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/other-project" }),
      expect.any(Object),
    );
    expect(showTemporarySession).toHaveBeenCalledWith("/other-project", expect.any(String), true);

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("creates agent drafts in the background without changing the visible session", async () => {
    const pendingSessions = {
      prepare: vi.fn(),
      setName: vi.fn(),
      setConfiguration: vi.fn(),
      createDraft: vi.fn(async () => undefined),
    };
    const registry = {
      pendingSessions,
      removeSession: vi.fn(),
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(registry, {} as SessionCatalogStore, {} as Client, "visible-session");
    store.projectPath = "/visible-project";

    const created = await store.createDraftSession("/other-project", "Draft", "Do this later");

    expect(pendingSessions.prepare).toHaveBeenCalledWith("/other-project", created);
    expect(pendingSessions.createDraft).toHaveBeenCalledWith(created, "Do this later", []);
    expect(store.projectPath).toBe("/visible-project");
    expect(store.activeSessionId).toBe("visible-session");
    expect(selectSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("starts agent-created sessions in the background without changing the visible session", async () => {
    const start = vi.fn(async () => undefined);
    const pendingSessions = {
      prepare: vi.fn(),
      setName: vi.fn(),
      setConfiguration: vi.fn(),
      projectSubmission: vi.fn(),
      materialize: vi.fn(),
    };
    const registry = {
      pendingSessions,
      removeSession: vi.fn(),
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      { projectSessions: { start } } as unknown as Client,
      "visible-session",
    );
    store.projectPath = "/visible-project";

    const created = await store.createSession("/other-project", "Background", "Run the tests");

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: created,
        workingDirectory: "/other-project",
        name: "Background",
        text: "Run the tests",
      }),
      expect.any(Object),
    );
    expect(pendingSessions.materialize).toHaveBeenCalledWith(created, "/other-project");
    expect(store.projectPath).toBe("/visible-project");
    expect(store.activeSessionId).toBe("visible-session");
    expect(selectSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("keeps a failed open attached to the selected session error state", async () => {
    const error = new Error("Cake could not find Project Session session-1");
    const open = vi.fn(async () => Promise.reject(error));
    const registry = {
      findSession: () => undefined,
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) => ({
        sessionId,
        workingDirectory: "/project",
        unread: false,
      }),
    } as SessionCatalogStore;
    const {
      root,
      subject: store,
      operations,
    } = mountWorkbench(registry, catalog, {
      projectSessions: { open },
    } as unknown as Client);

    await store.openSession("session-1");

    expect(store.contextError("session-1")).toEqual({
      message: "Cake could not find Project Session session-1",
      details: expect.stringContaining("Context:\nOpening Project Session"),
    });

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
