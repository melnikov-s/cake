import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
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
        projects: { find: () => undefined } as unknown as ProjectCatalogStore,
        globalLabels: () => [],
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

  it("does not expose family resolution through a child session", async () => {
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
        projects: { find: () => undefined } as unknown as ProjectCatalogStore,
        globalLabels: () => [],
        registry,
        reportError: vi.fn(),
      }),
      { projectSessions: { restore } } as unknown as Client,
    );

    await expect(subject.resolveSession("child", false)).resolves.toBe(false);

    expect(restore).not.toHaveBeenCalled();
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
        projects: { find: () => undefined } as unknown as ProjectCatalogStore,
        globalLabels: () => [],
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

  it("keeps selected labels with a draft until the Session becomes active", async () => {
    const statusId = "b925b5dd-9661-4f1a-9f40-406be3c96c27";
    const session = {
      sessionId: "session-1",
      projectPath: "/work/cake",
      workingDirectory: "/work/cake",
      draft: true,
      resolved: false,
    };
    const setPersistedLabels = vi.fn(async () => undefined);
    const setLabels = vi.fn(async () => undefined);
    let temporary = true;
    const operations = mount(createStore(SessionOperationCoordinatorStore));
    const registry = {
      findSession: () => ({ workspacePath: "/work/cake" }),
      pendingSessions: {
        conversation: () => undefined,
        isTemporary: () => temporary,
        setLabels,
      },
    } as unknown as SessionRegistryStore;
    const { root, subject } = mountWithClient(
      createStore(SessionManagementStore, {
        operations,
        catalog: { find: () => session } as unknown as SessionCatalogStore,
        projects: {
          find: () => ({
            workflow: {
              labels: [{ id: statusId, name: "Feature", color: "blue" }],
              assignments: [],
              sessionDetails: [],
            },
          }),
        } as unknown as ProjectCatalogStore,
        globalLabels: () => [],
        registry,
        reportError: vi.fn(),
      }),
      { projectWorkflow: { setSessionLabels: setPersistedLabels } } as unknown as Client,
    );

    expect(await subject.setSessionLabels("session-1", [statusId])).toBe(true);
    expect(setLabels).toHaveBeenCalledWith("session-1", [statusId]);
    expect(setPersistedLabels).not.toHaveBeenCalled();

    temporary = false;
    session.draft = false;
    expect(await subject.setSessionLabels("session-1", [])).toBe(true);
    expect(setPersistedLabels).toHaveBeenLastCalledWith(
      expect.objectContaining({ labelIds: [] }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    root[Symbol.dispose]();
    operations[Symbol.dispose]();
  });
});
