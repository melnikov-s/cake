import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import type { ExtensionUiStore } from "../../../../src/renderer/stores/ExtensionUiStore";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import { ProjectWorkbenchStore } from "../../../../src/renderer/stores/ProjectWorkbenchStore";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

function mountWorkbench(
  registry: SessionRegistryStore,
  catalog: SessionCatalogStore,
  rendererClient: RendererClient,
  initialActiveSessionId?: string,
) {
  let activeSessionId = initialActiveSessionId;
  const selectSession = vi.fn((sessionId: string) => {
    activeSessionId = sessionId;
  });
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const mounted = mountWithRendererClient(
    createStore(ProjectWorkbenchStore, {
      sessionRegistry: registry,
      operations,
      projects: {} as ProjectCatalogStore,
      reviews: () => ({}) as ReviewsStore,
      extensionUi: () => ({ clear: vi.fn() }) as unknown as ExtensionUiStore,
      catalog,
      startCakeChat: async () => undefined,
      onWorktreeSessionsResolved: async () => undefined,
      openSessionById: async () => undefined,
      activeSessionId: () => activeSessionId,
      selectSession,
      toggleProjectSidebar: vi.fn(),
      enterIdeSidebarMode: vi.fn(),
      leaveIdeSidebarMode: vi.fn(),
      projectSidebarWidth: () => 292,
    }),
    rendererClient,
  );
  return { ...mounted, operations, selectSession };
}

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
      isTemporarySession: () => false,
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
      { projectSessions: { open } } as unknown as RendererClient,
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
    const inspect = vi.fn(async () => undefined);
    const load = vi.fn();
    const registry = {
      findSession: () => undefined,
      load,
      isTemporarySession: () => false,
      isDraftSession: () => false,
    } as unknown as SessionRegistryStore;
    const {
      root,
      subject: store,
      operations,
      selectSession,
    } = mountWorkbench(
      registry,
      {} as SessionCatalogStore,
      { workspaces: { inspect } } as unknown as RendererClient,
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
    } as unknown as RendererClient);

    const opening = store.openSession("session-1");

    expect(selectSession).toHaveBeenCalledWith("session-1");
    expect(store.activeSessionId).toBe("session-1");
    expect(open).toHaveBeenCalled();

    finishOpen?.();
    await opening;
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
    } as unknown as RendererClient);

    await store.openSession("session-1");

    expect(store.contextError("session-1")).toEqual({
      message: "Cake could not find Project Session session-1",
      details: expect.stringContaining("Context:\nOpening Project Session"),
    });

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
