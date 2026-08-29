import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";

const summary = (id: string, modified: string) => ({
  id,
  title: id,
  created: modified,
  modified,
  messageCount: 1,
  resolved: false,
  unread: false,
  workspacePath: "/project",
  workspaceName: "Project",
});

describe("SessionCatalogStore", () => {
  it("sorts the initial Pi session index by latest activity", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([
      summary("older", "2026-08-15T12:00:00.000Z"),
      summary("latest", "2026-08-16T12:00:00.000Z"),
    ]);

    expect(store.sessions.map((session) => session.id)).toEqual(["latest", "older"]);
    store[Symbol.dispose]();
  });

  it("moves a session to the front when Pi reports newer activity", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([
      summary("first", "2026-08-16T12:00:00.000Z"),
      summary("second", "2026-08-15T12:00:00.000Z"),
    ]);
    store.applyWorkspace("/project", "Project", [
      { ...summary("first", "2026-08-16T12:00:00.000Z") },
      { ...summary("second", "2026-08-17T12:00:00.000Z") },
    ]);

    expect(store.sessions.map((session) => session.id)).toEqual(["second", "first"]);
    store[Symbol.dispose]();
  });

  it("pins unsubmitted 'New chat' sessions above all submitted sessions", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([
      summary("latest", "2026-08-16T12:00:00.000Z"),
      summary("older", "2026-08-15T12:00:00.000Z"),
      { ...summary("fresh", "2026-08-14T12:00:00.000Z"), messageCount: 0 },
    ]);

    expect(store.sessions.map((session) => session.id)).toEqual(["fresh", "latest", "older"]);
    store[Symbol.dispose]();
  });

  it("keeps newly created unsubmitted sessions on top when a workspace refreshes", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([summary("active", "2026-08-16T12:00:00.000Z")]);
    store.applyWorkspace("/project", "Project", [
      summary("active", "2026-08-16T12:00:00.000Z"),
      { ...summary("new-chat", "2026-08-10T00:00:00.000Z"), messageCount: 0 },
    ]);

    expect(store.projectSessions("/project").map((session) => session.id)).toEqual([
      "new-chat",
      "active",
    ]);
    store[Symbol.dispose]();
  });

  it("retains an unlisted pending session during workspace refresh", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([
      summary("persisted", "2026-08-16T12:00:00.000Z"),
      { ...summary("pending", "2026-08-17T12:00:00.000Z"), messageCount: 0 },
    ]);

    store.applyWorkspace(
      "/project",
      "Project",
      [summary("persisted", "2026-08-16T12:00:00.000Z")],
      ["pending"],
    );

    expect(store.projectSessions("/project").map((session) => session.id)).toEqual([
      "pending",
      "persisted",
    ]);
    store[Symbol.dispose]();
  });

  it("indexes sessions by ID and project without duplicating session records", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([
      summary("first", "2026-08-16T12:00:00.000Z"),
      {
        ...summary("second", "2026-08-15T12:00:00.000Z"),
        workspacePath: "/other",
        workspaceName: "Other",
      },
    ]);

    expect(store.sessionsById.get("first")).toBe(store.sessions[0]);
    expect(store.sessionsByProject.get("/other")).toEqual([store.sessions[1]]);
    expect(store.projectSessions("/project")).toEqual([store.sessions[0]]);
    store[Symbol.dispose]();
  });

  it("rejects duplicate session IDs across projects", () => {
    const store = mount(createStore(SessionCatalogStore));
    expect(() =>
      store.replace([
        summary("duplicate", "2026-08-16T12:00:00.000Z"),
        {
          ...summary("duplicate", "2026-08-15T12:00:00.000Z"),
          workspacePath: "/other",
          workspaceName: "Other",
        },
      ]),
    ).toThrow("Session ID collision detected: duplicate");
    store[Symbol.dispose]();
  });

  it("keeps Cake-owned resolved state when Pi refreshes workspace summaries", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([{ ...summary("resolved", "2026-08-16T12:00:00.000Z"), resolved: true }]);
    store.applyWorkspace("/project", "Project", [
      { ...summary("resolved", "2026-08-17T12:00:00.000Z"), resolved: false },
    ]);

    expect(store.sessions[0]?.resolved).toBe(true);
    store.applyResolvedState([]);
    expect(store.sessions[0]?.resolved).toBe(false);
    store[Symbol.dispose]();
  });

  it("applies the global resolved index to sessions discovered after hydration", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.applyResolvedState(["discovered"]);
    store.applyWorkspace("/project", "Project", [
      { ...summary("discovered", "2026-08-17T12:00:00.000Z"), resolved: false },
    ]);

    expect(store.find("discovered")?.resolved).toBe(true);
    store[Symbol.dispose]();
  });

  it("keeps Cake-owned unread reminders when Pi refreshes workspace summaries", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([{ ...summary("unread", "2026-08-16T12:00:00.000Z"), unread: true }]);
    store.applyWorkspace("/project", "Project", [
      { ...summary("unread", "2026-08-17T12:00:00.000Z"), resolved: false },
    ]);

    expect(store.sessions[0]?.unread).toBe(true);
    store.applyUnreadState([]);
    expect(store.sessions[0]?.unread).toBe(false);
    store[Symbol.dispose]();
  });

  it("applies the global unread index to sessions discovered after hydration", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.applyUnreadState(["discovered"]);
    store.applyWorkspace("/project", "Project", [
      { ...summary("discovered", "2026-08-17T12:00:00.000Z"), resolved: false },
    ]);

    expect(store.find("discovered")?.unread).toBe(true);
    store[Symbol.dispose]();
  });
});
