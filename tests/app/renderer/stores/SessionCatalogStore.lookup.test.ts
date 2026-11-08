import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { SessionSummary } from "../../../../src/renderer/models/SessionSummary";
import { WorktreeCatalog } from "../../../../src/renderer/models/WorktreeCatalog";
import {
  SessionCatalogStore,
  type PendingSessionSummary,
} from "../../../../src/renderer/stores/SessionCatalogStore";
import { sessionSummary } from "../fixtures/catalog-fixtures";

const summary = (sessionId: string) => sessionSummary({ sessionId, projectPath: "/project" });

describe("SessionCatalogStore indexed lookup", () => {
  it("preserves authority precedence and first-pending duplicate semantics across updates", () => {
    using model = SessionCatalog.create();
    using worktrees = WorktreeCatalog.create();
    const first = observable<PendingSessionSummary>({
      ...summary("one"),
      pending: true,
      title: "First pending",
    });
    const duplicate: PendingSessionSummary = { ...first, title: "Second pending" };
    const pending = observable([first, duplicate]);
    using store = mount(
      createStore(SessionCatalogStore, { model, worktrees, pendingSessions: () => pending }),
    );
    expect(store.find("one")).toBe(first);
    model.sessions.push(SessionSummary.create({ ...summary("one"), title: "Authoritative" }));
    const authoritative = model.find("one")!;
    expect(store.find("one")).toBe(authoritative);
    authoritative.resolved = true;
    expect(store.find("one")?.resolved).toBe(true);
    authoritative.sessionId = "renamed";
    expect(store.find("renamed")).toBe(authoritative);
    expect(store.find("one")).toBe(first);
    model.sessions.splice(0, 1);
    expect(store.find("renamed")).toBeUndefined();
    pending.splice(0, 1);
    expect(store.find("one")).toBe(duplicate);
    pending.splice(0, 1);
    expect(store.find("one")).toBeUndefined();
    pending.push(first);
    expect(store.find("one")).toBe(first);
    first.sessionId = "pending-renamed";
    expect(store.find("one")).toBeUndefined();
    expect(store.find("pending-renamed")).toBe(first);
  });
});
