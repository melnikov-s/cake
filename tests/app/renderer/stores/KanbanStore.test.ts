import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { KanbanStore } from "../../../../src/renderer/stores/KanbanStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

const projectPath = "/work/cake";
const statusId = "b925b5dd-9661-4f1a-9f40-406be3c96c27";

function fixture(options?: {
  draft?: boolean;
  resolved?: boolean;
  assigned?: boolean;
  details?: boolean;
  boardSelected?: boolean;
}) {
  const session = {
    sessionId: "session-1",
    title: "Build Kanban",
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    projectPath,
    projectName: "Cake",
    workingDirectory: projectPath,
    draft: options?.draft ?? false,
    resolved: options?.resolved ?? false,
  };
  const project = {
    path: projectPath,
    name: "Cake",
    workflow: {
      columns: [{ id: statusId, name: "In progress", color: "sky" as const }],
      assignments: options?.assigned ? [{ sessionId: session.sessionId, statusId }] : [],
      sessionDetails:
        options?.details === false
          ? []
          : [
              {
                sessionId: session.sessionId,
                model: { provider: "openai", modelId: "gpt-5" },
                description: "Build the project Kanban board.",
              },
            ],
    },
  };
  const mutate = vi.fn(async () => project.workflow);
  const resolveSession = vi.fn(async () => true);
  const activateDraft = vi.fn(async () => true);
  const registry = {
    findSession: () => ({ chatStore: { activateDraft }, model: {} }),
    pendingConfiguration: () => undefined,
    draftSessionPrompt: () => ({ text: "Build a Kanban board", attachments: [], resolved: false }),
  } as unknown as SessionRegistryStore;
  const catalog = {
    find: (sessionId: string) => (sessionId === session.sessionId ? session : undefined),
    projectSessions: (path: string) => (path === projectPath ? [session] : []),
  } as unknown as SessionCatalogStore;
  const projects = {
    find: (path: string) => (path === projectPath ? project : undefined),
  } as unknown as ProjectCatalogStore;
  const describeSession = vi.fn(async () => project.workflow.sessionDetails[0]!);
  const { root, subject } = mountWithRendererClient(
    createStore(KanbanStore, {
      projects,
      catalog,
      registry,
      setSessionResolved: resolveSession,
      selectedProjectPath: () => (options?.boardSelected === false ? undefined : projectPath),
      utilityModelConfigured: () => true,
      openSession: vi.fn(async () => true),
      reportError: vi.fn(),
    }),
    {
      projectWorkflow: {
        mutate,
        describeSession,
      },
    } as unknown as RendererClient,
  );
  return {
    root,
    store: subject,
    project,
    mutate,
    describeSession,
    resolveSession,
    activateDraft,
  };
}

describe("KanbanStore", () => {
  it("derives lifecycle columns before custom workflow status", () => {
    const active = fixture({ assigned: true });
    expect(active.store.columnForSession("session-1")).toBe(statusId);
    active.root[Symbol.dispose]();

    const draft = fixture({ draft: true, assigned: true });
    expect(draft.store.columnForSession("session-1")).toBe("draft");
    draft.root[Symbol.dispose]();

    const resolved = fixture({ resolved: true, assigned: true });
    expect(resolved.store.columnForSession("session-1")).toBe("resolved");
    resolved.root[Symbol.dispose]();
  });

  it("falls back to Active when a persisted custom status no longer exists", () => {
    const test = fixture({ assigned: true });
    test.project.workflow.assignments = [
      {
        sessionId: "session-1",
        statusId: "4535dbea-37f9-4a71-a124-7eaab6a57d88",
      },
    ];
    expect(test.store.columnForSession("session-1")).toBe("active");
    test.root[Symbol.dispose]();
  });

  it("generates Draft descriptions from the staged prompt", async () => {
    const test = fixture({ draft: true, details: false });
    await vi.waitFor(() =>
      expect(test.describeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
          firstUserMessage: "Build a Kanban board",
        }),
        expect.anything(),
      ),
    );
    test.root[Symbol.dispose]();
  });

  it("moves among Active and custom columns without changing lifecycle", async () => {
    const test = fixture({ boardSelected: false });
    expect(await test.store.moveSession("session-1", statusId)).toBe(true);
    expect(test.mutate).toHaveBeenCalledWith(
      {
        projectPath,
        mutation: { _tag: "SetSessionStatus", sessionId: "session-1", statusId },
      },
      expect.anything(),
    );
    expect(test.resolveSession).not.toHaveBeenCalled();
    test.root[Symbol.dispose]();
  });

  it("restores before assigning a resolved session to a custom column", async () => {
    const test = fixture({ resolved: true, assigned: true });
    expect(await test.store.moveSession("session-1", statusId)).toBe(true);
    expect(test.resolveSession).toHaveBeenCalledWith("session-1", false);
    expect(test.mutate).toHaveBeenCalled();
    test.root[Symbol.dispose]();
  });

  it("activates a Draft before assigning its custom status", async () => {
    const test = fixture({ draft: true });
    expect(await test.store.moveSession("session-1", statusId)).toBe(true);
    expect(test.activateDraft).toHaveBeenCalledOnce();
    expect(test.mutate).toHaveBeenCalled();
    test.root[Symbol.dispose]();
  });

  it("does not activate a Draft directly into Resolved", async () => {
    const test = fixture({ draft: true });
    expect(await test.store.moveSession("session-1", "resolved")).toBe(false);
    expect(test.activateDraft).not.toHaveBeenCalled();
    expect(test.resolveSession).not.toHaveBeenCalled();
    test.root[Symbol.dispose]();
  });

  it("preserves custom status when resolving", async () => {
    const test = fixture({ assigned: true });
    expect(await test.store.moveSession("session-1", "resolved")).toBe(true);
    expect(test.resolveSession).toHaveBeenCalledWith("session-1", true);
    expect(test.mutate).not.toHaveBeenCalled();
    test.root[Symbol.dispose]();
  });
});
