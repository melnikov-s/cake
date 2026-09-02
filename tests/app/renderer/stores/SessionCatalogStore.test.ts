import { applySnapshot, createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { WorktreeRecord } from "../../../../src/ipc/worktree-contract";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";

const worktree = (state: WorktreeRecord["state"] = "active"): WorktreeRecord => ({
  projectPath: "/project",
  worktreePath: "/worktree",
  branch: "agent/session",
  baseBranch: "main",
  state,
  createdAt: new Date(0).toISOString(),
});

const session = (sessionId: string, modifiedAt: string, managedWorktree?: WorktreeRecord) => ({
  sessionId,
  title: sessionId,
  createdAt: modifiedAt,
  modifiedAt,
  messageCount: 1,
  resolved: false,
  unread: false,
  projectPath: "/project",
  projectName: "project",
  workingDirectory: managedWorktree?.worktreePath ?? "/project",
  managedWorktree,
  pending: false,
  draft: false,
});

describe("SessionCatalogStore indexes", () => {
  it("reuses project and worktree indexes until the catalog changes", () => {
    const model = SessionCatalog.create({
      sessions: [
        session("newer", "2026-01-02T00:00:00.000Z", worktree()),
        session("older", "2026-01-01T00:00:00.000Z"),
      ],
    });
    const store = mount(createStore(SessionCatalogStore, { model }));

    const firstProjectSessions = store.projectSessions("/project");
    expect(store.projectSessions("/project")).toBe(firstProjectSessions);
    expect(store.find("newer")).toBe(firstProjectSessions[0]);
    expect(store.managedWorktree("/worktree")).toEqual(worktree());

    applySnapshot(model, {
      sessions: [
        ...model.sessions.map((current) => toSnapshot(current)),
        session("newest", "2026-01-03T00:00:00.000Z"),
      ],
    });

    expect(store.projectSessions("/project")).not.toBe(firstProjectSessions);
    expect(store.projectSessions("/project").map((current) => current.sessionId)).toEqual([
      "newest",
      "newer",
      "older",
    ]);
    store[Symbol.dispose]();
  });

  it("lets a renderer-local managed-worktree update override the projected record", () => {
    const model = SessionCatalog.create({
      sessions: [session("session", "2026-01-01T00:00:00.000Z", worktree())],
    });
    const store = mount(createStore(SessionCatalogStore, { model }));
    const landed = worktree("landed");

    store.noteManagedWorktree(landed);

    expect(store.managedWorktree("/worktree")).toBe(landed);
    store[Symbol.dispose]();
  });

  it("shows the first-message projection until the authoritative Pi summary arrives", () => {
    const model = SessionCatalog.create({ sessions: [] });
    const pending = [
      {
        ...session("new-session", "2026-01-03T00:00:00.000Z"),
        title: "Hi",
        pending: true as const,
      },
    ];
    const store = mount(
      createStore(SessionCatalogStore, { model, pendingSessions: () => pending }),
    );

    expect(store.sessions).toMatchObject([
      {
        sessionId: "new-session",
        title: "Hi",
        messageCount: 1,
        pending: true,
      },
    ]);

    applySnapshot(model, {
      sessions: [
        {
          ...session("new-session", "2026-01-03T00:00:00.000Z"),
          title: "Authoritative Pi title",
        },
      ],
    });

    expect(store.sessions).toHaveLength(1);
    expect(store.find("new-session")).toMatchObject({
      title: "Authoritative Pi title",
      pending: false,
    });
    store[Symbol.dispose]();
  });
});
