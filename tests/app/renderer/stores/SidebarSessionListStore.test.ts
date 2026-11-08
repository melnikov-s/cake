import { afterEach, describe, expect, it, vi } from "vitest";
import { applySnapshot } from "r-state-tree";
import { defaultProjectWorkflow } from "../../../../src/contracts/application/application-data";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

const projectPath = "/project";
afterEach(() => vi.restoreAllMocks());

describe("Sidebar session label ordering", () => {
  it("builds label order once per sort, preserving activity, label, date and identity ties", () => {
    const labels = [
      { id: "first", name: "First", color: "sky" as const },
      { id: "second", name: "Second", color: "sky" as const },
    ];
    const assignments = [
      { sessionId: "older-first", labelIds: ["first"] },
      { sessionId: "newer-first", labelIds: ["first"] },
      { sessionId: "second", labelIds: ["second", "first"] },
      { sessionId: "working", labelIds: ["second"] },
      { sessionId: "unknown", labelIds: ["missing"] },
    ];
    using fixture = createRendererStoreFixture({
      projects: [
        projectRecord({
          path: projectPath,
          workflow: {
            ...defaultProjectWorkflow(),
            labels,
            assignments,
          },
        }),
      ],
      sessions: [
        "unknown",
        "tie-b",
        "older-first",
        "working",
        "second",
        "tie-a",
        "newer-first",
      ].map((sessionId) =>
        sessionSummary({
          sessionId,
          projectPath,
          running: sessionId === "working",
          modifiedAt: sessionId === "newer-first" ? "2026-02-01T00:00:00.000Z" : undefined,
        }),
      ),
    });
    const list = fixture.root.sidebarStore.sessionListStore;
    const metadata = fixture.root.sessionMetadataStore;
    // Count only the sort-level label read, not SessionMetadataStore's independent
    // label-validation reads per assignment (outside this hotspot's ownership).
    vi.spyOn(metadata, "sessionLabelIds").mockImplementation(
      (id) => assignments.find((assignment) => assignment.sessionId === id)?.labelIds ?? [],
    );
    const projectLabels = vi.spyOn(metadata, "projectLabels");
    list.setProjectSessionSort(projectPath, "label");
    const order = () => list.projectSessions(projectPath).map(({ sessionId }) => sessionId);
    expect(order()).toEqual([
      "working",
      "newer-first",
      "older-first",
      "second",
      "tie-a",
      "tie-b",
      "unknown",
    ]);
    expect(projectLabels).toHaveBeenCalledTimes(1);
    expect(order()).toEqual([
      "working",
      "newer-first",
      "older-first",
      "second",
      "tie-a",
      "tie-b",
      "unknown",
    ]);
    expect(projectLabels).toHaveBeenCalledTimes(1);
    const project = fixture.models.projects.find(projectPath)!;
    applySnapshot(project, {
      ...projectRecord({ path: projectPath }),
      workflow: { ...defaultProjectWorkflow(), labels: [...labels].reverse(), assignments },
    });
    expect(order()).toEqual([
      "working",
      "second",
      "newer-first",
      "older-first",
      "tie-a",
      "tie-b",
      "unknown",
    ]);
    expect(projectLabels).toHaveBeenCalledTimes(2);
    list.setProjectSessionSort(projectPath, "date");
    order();
    expect(projectLabels).toHaveBeenCalledTimes(2);
  });

  it("keeps recursive activity and ancestor traversal cycle guards with indexed lookups", () => {
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: projectPath })],
      sessions: [
        sessionSummary({
          sessionId: "one",
          projectPath,
          familyParentSessionId: "two",
          familyChildSessionIds: ["two", "missing"],
        }),
        sessionSummary({
          sessionId: "two",
          projectPath,
          familyParentSessionId: "one",
          familyChildSessionIds: ["one"],
        }),
      ],
    });
    const list = fixture.root.sidebarStore.sessionListStore;
    const scans = vi.spyOn(fixture.models.sessionCatalog.sessions, "find");
    expect(
      list.sessionActivityForDisplay(fixture.root.sessionCatalogStore.find("one")!),
    ).toBeUndefined();
    fixture.models.sessionCatalog.find("two")!.running = true;
    expect(list.sessionActivityForDisplay(fixture.root.sessionCatalogStore.find("one")!)).toBe(
      "running",
    );
    // Internal traversal contract: malformed family cycles must still terminate.
    expect(list["sidebarAncestorIds"]("one")).toEqual(["two"]);
    expect(scans).not.toHaveBeenCalled();
  });
});
