import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { ProjectCatalogStore } from "../../../../src/renderer/stores/ProjectCatalogStore";
import type { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";
import { SessionMetadataStore } from "../../../../src/renderer/stores/SessionMetadataStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";

const globalLabel = { id: "global", name: "Global", color: "blue" as const };
const projectLabel = { id: "project", name: "Project", color: "violet" as const };

function mountStore(input: {
  session?: { sessionId: string; projectPath: string; resolved: boolean; unread?: boolean };
  pending?: { sessionId: string; workspacePath: string; labelIds: readonly string[] };
}) {
  const assignments = input.session
    ? [{ sessionId: input.session.sessionId, labelIds: [projectLabel.id, "missing"] }]
    : [];
  const projects = {
    find: (path: string) =>
      path === "/cake" ? { workflow: { labels: [projectLabel], assignments } } : undefined,
  } as unknown as ProjectCatalogStore;
  const catalog = {
    find: (sessionId: string) =>
      input.session?.sessionId === sessionId ? input.session : undefined,
    projectOfManagedWorktree: (path: string) => (path === "/worktree" ? "/cake" : undefined),
  } as unknown as SessionCatalogStore;
  const sessions = {
    findSession: (sessionId: string) =>
      input.pending?.sessionId === sessionId
        ? { workspacePath: input.pending.workspacePath }
        : undefined,
    pendingSessions: {
      isTemporary: (sessionId: string) => input.pending?.sessionId === sessionId,
      conversation: (sessionId: string) =>
        input.pending?.sessionId === sessionId ? { labelIds: input.pending.labelIds } : undefined,
    },
  } as unknown as SessionRegistryStore;
  return mount(
    createStore(SessionMetadataStore, {
      projects,
      catalog,
      sessions,
      globalLabels: () => [globalLabel],
    }),
  );
}

describe("SessionMetadataStore", () => {
  it("joins global and Project labels and filters assignments against the available catalog", () => {
    const store = mountStore({
      session: { sessionId: "session-1", projectPath: "/cake", resolved: false },
    });

    expect(store.availableSessionLabels("session-1")).toEqual([globalLabel, projectLabel]);
    expect(store.sessionLabelIds("session-1")).toEqual([projectLabel.id]);
    expect(store.sessionLabels("session-1")).toEqual([projectLabel]);
    store[Symbol.dispose]();
  });

  it("uses pending draft labels through managed-worktree Project routing", () => {
    const store = mountStore({
      pending: {
        sessionId: "draft-1",
        workspacePath: "/worktree",
        labelIds: [globalLabel.id, "missing"],
      },
    });

    expect(store.availableSessionLabels("draft-1")).toEqual([globalLabel, projectLabel]);
    expect(store.sessionLabelIds("draft-1")).toEqual([globalLabel.id]);
    store[Symbol.dispose]();
  });

  it("does not expose workflow assignments for resolved sessions", () => {
    const store = mountStore({
      session: { sessionId: "resolved-1", projectPath: "/cake", resolved: true },
    });

    expect(store.availableSessionLabels("resolved-1")).toEqual([globalLabel, projectLabel]);
    expect(store.sessionLabelIds("resolved-1")).toEqual([]);
    store[Symbol.dispose]();
  });
});
