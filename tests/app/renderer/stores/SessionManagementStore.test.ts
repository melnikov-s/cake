import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionManagementStore } from "../../../../src/renderer/stores/SessionManagementStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

describe("SessionManagementStore deletion", () => {
  it("deletes a resolved renderer draft without calling the Project Session backend", async () => {
    const deleteResolvedDraftSession = vi.fn(async () => true);
    const deleteSession = vi.fn(async () => undefined);
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const registry = {
      isDraftSession: (sessionId: string) => sessionId === "draft-1",
      deleteResolvedDraftSession,
      removeSession: vi.fn(),
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) =>
        sessionId === "draft-1" ? { sessionId, resolved: true } : undefined,
    } as SessionCatalogStore;
    const { root, subject } = mountWithRendererClient(
      createStore(SessionManagementStore, {
        operations,
        catalog,
        registry,
        reportError: vi.fn(),
      }),
      { workspaces: { deleteSession } } as unknown as RendererClient,
    );

    await subject.deleteSession("draft-1");

    expect(deleteResolvedDraftSession).toHaveBeenCalledWith("draft-1");
    expect(deleteSession).not.toHaveBeenCalled();
    expect(registry.removeSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
