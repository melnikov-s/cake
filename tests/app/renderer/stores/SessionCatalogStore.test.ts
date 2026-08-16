import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionCatalogStore } from "../../../../src/renderer/stores/SessionCatalogStore";

const summary = (id: string, modified: string) => ({
  id,
  title: id,
  created: modified,
  modified,
  messageCount: 1,
  archived: false,
  workspacePath: "/project",
  workspaceName: "Project"
});

describe("SessionCatalogStore", () => {
  it("sorts the initial Pi session index by latest activity", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([
      summary("older", "2026-08-15T12:00:00.000Z"),
      summary("latest", "2026-08-16T12:00:00.000Z")
    ]);

    expect(store.sessions.map((session) => session.id)).toEqual(["latest", "older"]);
    store[Symbol.dispose]();
  });

  it("moves a session to the front when Pi reports newer activity", () => {
    const store = mount(createStore(SessionCatalogStore));
    store.replace([
      summary("first", "2026-08-16T12:00:00.000Z"),
      summary("second", "2026-08-15T12:00:00.000Z")
    ]);
    store.applyWorkspace("/project", "Project", [
      { ...summary("first", "2026-08-16T12:00:00.000Z") },
      { ...summary("second", "2026-08-17T12:00:00.000Z") }
    ]);

    expect(store.sessions.map((session) => session.id)).toEqual(["second", "first"]);
    store[Symbol.dispose]();
  });
});
