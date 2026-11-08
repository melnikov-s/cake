import { Model, applySnapshot, child, effect, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../../../../src/renderer/models/SessionCatalog";
import { SessionSummary } from "../../../../src/renderer/models/SessionSummary";
import { sessionSummary } from "../fixtures/catalog-fixtures";

const summary = (sessionId: string) => sessionSummary({ sessionId, projectPath: "/project" });

describe("SessionCatalog indexed lookup", () => {
  it("tracks insertion, removal, replacement, id mutation and snapshot reconciliation", () => {
    using catalog = SessionCatalog.create({ sessions: [summary("one")] });
    const one = catalog.find("one")!;
    expect(catalog.find("missing")).toBeUndefined();
    catalog.sessions.push(SessionSummary.create(summary("two")));
    const two = catalog.find("two")!;
    expect(two).toBe(catalog.sessions[1]);
    one.title = "Renamed";
    one.resolved = true;
    expect(catalog.find("one")).toMatchObject({ title: "Renamed", resolved: true });
    two.sessionId = "renamed-id";
    expect(catalog.find("two")).toBeUndefined();
    expect(catalog.find("renamed-id")).toBe(two);
    catalog.sessions.splice(0, 1);
    expect(catalog.find("one")).toBeUndefined();
    const replacement = SessionSummary.create(summary("renamed-id"));
    catalog.sessions.splice(0, 1, replacement);
    expect(catalog.find("renamed-id")).toBe(replacement);
    applySnapshot(catalog, { sessions: [summary("new")] });
    expect(catalog.find("renamed-id")).toBeUndefined();
    expect(catalog.find("new")).toBe(catalog.sessions[0]);
    expect(toSnapshot(catalog)).not.toHaveProperty("sessionIndex");
  });

  it("preserves duplicate rejection and keeps the index fresh after a rejected id change", () => {
    using catalog = SessionCatalog.create({ sessions: [summary("one"), summary("two")] });
    const one = catalog.find("one");
    const two = catalog.find("two")!;
    expect(() => {
      two.sessionId = "one";
    }).toThrow();
    expect(catalog.find("one")).toBe(one);
    expect(catalog.find("two")).toBe(two);
    expect(() => SessionCatalog.create({ sessions: [summary("one"), summary("one")] })).toThrow();
  });

  it("does no collection scans for 1,000 lookups, summary edits or identity changes", () => {
    using catalog = SessionCatalog.create({
      sessions: Array.from({ length: 1_000 }, (_, index) => summary(`session-${index}`)),
    });
    const iterations = vi.spyOn(catalog.sessions, Symbol.iterator);
    const scans = vi.spyOn(catalog.sessions, "find");
    try {
      for (let index = 0; index < 1_000; index++)
        expect(catalog.find(`session-${index}`)).toBe(catalog.sessions[index]);
      const first = catalog.find("session-0")!;
      first.title = "Changed";
      first.resolved = true;
      expect(catalog.find("session-0")).toBe(first);
      expect(iterations).not.toHaveBeenCalled();
      expect(scans).not.toHaveBeenCalled();
      catalog.sessions.push(SessionSummary.create(summary("added")));
      expect(catalog.find("added")).toBe(catalog.sessions.at(-1));
      iterations.mockClear();
      first.sessionId = "changed-id";
      expect(catalog.find("session-0")).toBeUndefined();
      expect(catalog.find("changed-id")).toBe(first);
      expect(iterations).not.toHaveBeenCalled();
    } finally {
      iterations.mockRestore();
      scans.mockRestore();
    }
  });

  it("limits tree-wide identity lookup to this catalog", () => {
    class CatalogPair extends Model {
      @child(SessionCatalog) first = SessionCatalog.create();
      @child(SessionCatalog) second = SessionCatalog.create();
    }
    using root = CatalogPair.create({
      first: { sessions: [summary("one")] },
      second: { sessions: [summary("two")] },
    });
    expect(root.first.find("two")).toBeUndefined();
    expect(root.second.find("one")).toBeUndefined();
    expect(root.first.find("one")).toBe(root.first.sessions[0]);
    expect(root.second.find("two")).toBe(root.second.sessions[0]);
  });

  it("notifies reactive lookup consumers when a missing session arrives or is removed", () => {
    using catalog = SessionCatalog.create();
    const seen: Array<string | undefined> = [];
    const stop = effect(() => {
      seen.push(catalog.find("one")?.title);
    });
    try {
      catalog.sessions.push(SessionSummary.create(summary("one")));
      catalog.find("one")!.title = "Updated";
      catalog.sessions.splice(0, 1);
      expect(seen).toEqual([undefined, "one", "Updated", undefined]);
    } finally {
      stop();
    }
  });
});
