/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applySnapshot, effect, toSnapshot } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../../src/renderer/components/sidebar";
import type { RendererClient } from "../../../src/renderer/client/RendererClient";
import { mountRootStore } from "../../../src/renderer/mount-root-store";
import { RendererModels } from "../../../src/renderer/RendererModels";
import type { RootStore } from "../../../src/renderer/stores/RootStore";

const projectPath = "/projects/sidebar-sync";
const worktreePath = "/projects/.cake-worktrees/sidebar-sync-generated";

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((complete) => (resolve = complete)),
    resolve,
  };
}

function authoritativeSession(sessionId: string, modifiedAt: string) {
  return {
    sessionId,
    title: sessionId,
    createdAt: modifiedAt,
    modifiedAt,
    // The lightweight Pi catalog deliberately does not inspect transcripts.
    messageCount: 0,
    resolved: false,
    unread: false,
    projectPath,
    projectName: "Sidebar Sync",
    workingDirectory: projectPath,
    pending: false,
    draft: false,
  };
}

function sidebar(root: RootStore) {
  return (
    <Sidebar
      store={root.sidebarStore}
      projects={root.projectCatalogStore}
      chat={root.projectWorkbenchStore}
      cakeChat={root.cakeChatCollectionStore}
      shell={root.appShellStore}
      projectSettings={root.projectSettingsStore}
      onOpenSettings={() => undefined}
      onOpenKanban={() => undefined}
      onOpenCakeChat={() => undefined}
      onCreateCakeChat={() => undefined}
      onOpenSession={() => undefined}
      onCreateSession={() => undefined}
      onRemoveProject={async () => true}
      onChooseProject={() => undefined}
      onGoBack={() => undefined}
      onGoForward={() => undefined}
      onToggle={() => undefined}
    />
  );
}

describe("Project Session catalog to sidebar synchronization", () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let models: RendererModels;
  let root: RootStore;
  let start: ReturnType<typeof deferred>;

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    models = new RendererModels();
    applySnapshot(models.projects, {
      projects: [
        {
          path: projectPath,
          name: "Sidebar Sync",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          settings: { worktreeCreateCommand: "", worktreeSetupCommands: "" },
        },
      ],
    });
    applySnapshot(models.sessionCatalog, {
      sessions: Array.from({ length: 10 }, (_, index) =>
        authoritativeSession(
          `lightweight-pi-${index}`,
          `2025-12-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
        ),
      ),
    });
    start = deferred();
    const client = {
      electron: {
        showProjectContextMenu: async () => undefined,
        showSessionContextMenu: async () => undefined,
      },
      projectSessions: { start: vi.fn(() => start.promise) },
    } as unknown as RendererClient;
    root = mountRootStore(client, { state: {}, children: {} }, async () => undefined, models);
    await act(async () => reactRoot.render(sidebar(root)));
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    root[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("keeps one observed row from control-created draft through activation and authority", async () => {
    const create = () =>
      root.appControl.invoke({
        name: "sessions.create-draft",
        arguments: {
          workspacePath: projectPath,
          name: "Duplicate title",
          initialPrompt: "Keep this work staged.",
        },
      });
    let first!: Awaited<ReturnType<typeof create>>;
    let second!: Awaited<ReturnType<typeof create>>;
    await act(async () => {
      first = await create();
      second = await create();
    });
    const firstId = (first as { sessionId: string }).sessionId;
    const secondId = (second as { sessionId: string }).sessionId;
    const row = () => container.querySelectorAll(`[data-session-id="${firstId}"]`);

    expect(first).toMatchObject({ ok: true, status: "saved-draft" });
    expect(second).toMatchObject({ ok: true, status: "saved-draft" });
    expect(firstId).not.toBe(secondId);
    expect(row()).toHaveLength(1);
    const visibleStates: boolean[] = [];
    const stopTrackingVisibility = effect(() => {
      visibleStates.push(
        root.sidebarStore
          .projectSessions(projectPath)
          .slice(0, root.sidebarStore.sessionLimit(projectPath))
          .some((session) => session.sessionId === firstId),
      );
    });

    await act(async () => {
      root.sessionCatalogStore.noteManagedWorktree({
        projectPath,
        worktreePath,
        branch: "agent/sidebar-sync-generated",
        baseBranch: "main",
        state: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      root.sessionRegistry.relocateTemporarySession(firstId, worktreePath);
      await root.openSession(firstId);
    });
    expect(root.sessionCatalogStore.find(firstId)?.projectPath).toBe(projectPath);
    expect(row()).toHaveLength(1);

    let activation!: Promise<boolean>;
    await act(async () => {
      activation = root.sessionRegistry
        .findSession(firstId)!
        .composerStore.activateDraftSession({ kind: "current" });
      await Promise.resolve();
    });
    expect(root.sessionRegistry.isDraftSession(firstId)).toBe(false);
    expect(row()).toHaveLength(1);

    await act(async () => {
      const existing = models.sessionCatalog.sessions.map((session) => toSnapshot(session));
      applySnapshot(models.sessionCatalog, {
        sessions: [
          ...existing,
          {
            ...authoritativeSession(firstId, "2026-01-03T00:00:00.000Z"),
            title: "Duplicate title",
            workingDirectory: worktreePath,
            managedWorktree: {
              projectPath,
              worktreePath,
              branch: "agent/sidebar-sync-generated",
              baseBranch: "main",
              state: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          },
        ],
      });
    });
    expect(
      root.sessionCatalogStore.sessions.filter((session) => session.sessionId === firstId),
    ).toHaveLength(1);
    expect(row()).toHaveLength(1);

    await act(async () => {
      start.resolve();
      await activation;
    });
    expect(root.sessionCatalogStore.find(firstId)).toMatchObject({
      sessionId: firstId,
      pending: false,
      workingDirectory: worktreePath,
    });
    expect(row()).toHaveLength(1);
    stopTrackingVisibility();
    expect(visibleStates.every(Boolean)).toBe(true);
  });
});
