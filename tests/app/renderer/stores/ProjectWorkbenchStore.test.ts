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

describe("ProjectWorkbenchStore startup selection", () => {
  it("hydrates its runtime view from the shell selection without persisting another selection", async () => {
    const inspect = vi.fn(async () => undefined);
    const load = vi.fn();
    const onSessionShown = vi.fn();
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const registry = {
      findSession: () => undefined,
      load,
      isTemporarySession: () => false,
      isDraftSession: () => false,
    } as unknown as SessionRegistryStore;
    const { root, subject: store } = mountWithRendererClient(
      createStore(ProjectWorkbenchStore, {
        sessionRegistry: registry,
        operations,
        projects: {} as ProjectCatalogStore,
        reviews: () => ({}) as ReviewsStore,
        extensionUi: () => ({ clear: vi.fn() }) as unknown as ExtensionUiStore,
        catalog: {} as SessionCatalogStore,
        startCakeChat: async () => undefined,
        onWorktreeSessionsResolved: async () => undefined,
        openSessionById: async () => undefined,
        onSessionShown,
        toggleProjectSidebar: vi.fn(),
      }),
      { workspaces: { inspect } } as unknown as RendererClient,
    );

    await store.initialize({ workspacePath: "/project", sessionId: "session-1" });

    expect(store.projectPath).toBe("/project");
    expect(store.selectedSessionId).toBe("session-1");
    expect(load).toHaveBeenCalledWith("session-1", "/project");
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/project" }),
      expect.any(Object),
    );
    expect(toSnapshot(store).state).not.toHaveProperty("selectedSessionId");
    expect(onSessionShown).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
