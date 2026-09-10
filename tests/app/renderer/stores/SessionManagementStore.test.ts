import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionManagementStore } from "../../../../src/renderer/stores/SessionManagementStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { mountWithClient } from "../mount-with-client";

describe("SessionManagementStore", () => {
  it("deletes a resolved renderer draft without calling the Project Session backend", async () => {
    const deleteResolvedDraft = vi.fn(async () => true);
    const deleteSession = vi.fn(async () => undefined);
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const registry = {
      pendingSessions: {
        isDraft: (sessionId: string) => sessionId === "draft-1",
        deleteResolvedDraft,
      },
      removeSession: vi.fn(),
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) =>
        sessionId === "draft-1" ? { sessionId, resolved: true } : undefined,
    } as SessionCatalogStore;
    const { root, subject } = mountWithClient(
      createStore(SessionManagementStore, {
        operations,
        catalog,
        registry,
        reportError: vi.fn(),
      }),
      { workspaces: { deleteSession } } as unknown as Client,
    );

    await subject.deleteSession("draft-1");

    expect(deleteResolvedDraft).toHaveBeenCalledWith("draft-1");
    expect(deleteSession).not.toHaveBeenCalled();
    expect(registry.removeSession).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("restores a Session Family through its parent when messaging a resolved child", async () => {
    const restore = vi.fn(async () => undefined);
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const registry = {
      pendingSessions: {
        conversation: () => undefined,
        isTemporary: () => false,
      },
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) =>
        ["parent", "child"].includes(sessionId)
          ? {
              sessionId,
              workingDirectory: "/project",
              familyParentSessionId: "parent",
            }
          : undefined,
    } as SessionCatalogStore;
    const { root, subject } = mountWithClient(
      createStore(SessionManagementStore, {
        operations,
        catalog,
        registry,
        reportError: vi.fn(),
      }),
      { projectSessions: { restore } } as unknown as Client,
    );

    await expect(subject.resolveSession("child", false)).resolves.toBe(true);

    expect(restore).toHaveBeenCalledWith(
      { sessionId: "parent", workingDirectory: "/project" },
      expect.anything(),
    );
    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });

  it("resolves a requested Session Family through its parent once", async () => {
    const resolve = vi.fn(async () => undefined);
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const registry = {
      pendingSessions: {
        conversation: () => undefined,
        isTemporary: () => false,
      },
    } as unknown as SessionRegistryStore;
    const catalog = {
      find: (sessionId: string) =>
        ["parent", "child"].includes(sessionId)
          ? {
              sessionId,
              workingDirectory: "/project",
              familyParentSessionId: "parent",
            }
          : undefined,
    } as SessionCatalogStore;
    const reportError = vi.fn();
    const { root, subject } = mountWithClient(
      createStore(SessionManagementStore, {
        operations,
        catalog,
        registry,
        reportError,
      }),
      { projectSessions: { resolve } } as unknown as Client,
    );

    await expect(subject.resolveSessionsById(["child", "parent"], true)).resolves.toBe(2);

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(
      { sessionId: "parent", workingDirectory: "/project" },
      expect.anything(),
    );
    expect(reportError).not.toHaveBeenCalled();

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
