import { effect } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { applySessionCatalogGroupUpdate } from "../../../../src/renderer/reducers/CatalogReducer";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Narrow internal performance contracts: React text assertions cannot detect reference-cache
// churn or unnecessary derivations. Keep real Root composition, Models, and authority reducers.
// Visible ordering/title handoff lives in session-catalog-workflow.test.tsx; pending-worktree
// authority takeover/removal now lives in session-identity-workflow.test.tsx.
describe("Session catalog derivation integration", () => {
  it("reuses a Project group until its authority changes", () => {
    const projectPath = "/project";
    const older = sessionSummary({ sessionId: "older", projectPath });
    const newer = sessionSummary({
      sessionId: "newer",
      projectPath,
      modifiedAt: "2026-01-02T00:00:00.000Z",
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: projectPath, name: "Project" })],
      sessions: [newer, older],
    });
    const store = fixture.root.sessionCatalogStore;
    const firstGroup = store.projectSessions(projectPath);
    expect(store.projectSessions(projectPath)).toBe(firstGroup);
    expect(store.find("newer")).toBe(firstGroup[0]);

    applySessionCatalogGroupUpdate(
      fixture.models.sessionCatalog,
      { projectPath, resolved: false },
      {
        _tag: "Event",
        revision: 1,
        event: {
          _tag: "Upserted",
          session: sessionSummary({
            sessionId: "newest",
            projectPath,
            modifiedAt: "2026-01-03T00:00:00.000Z",
          }),
        },
      },
    );
    const nextGroup = store.projectSessions(projectPath);
    expect(nextGroup).not.toBe(firstGroup);
    expect(store.projectSessions(projectPath)).toBe(nextGroup);
    expect(store.find("newest")).toBe(nextGroup[0]);
  });

  it("does not rederive another Project group for metadata or resolution updates", () => {
    const projectPath = "/project";
    const original = sessionSummary({ sessionId: "project-session", projectPath });
    using fixture = createRendererStoreFixture({
      projects: [
        projectRecord({ path: projectPath, name: "Project" }),
        projectRecord({ path: "/other", name: "Other" }),
      ],
      sessions: [original, sessionSummary({ sessionId: "other-session", projectPath: "/other" })],
    });
    let otherProjectDerivations = 0;
    const stop = effect(() => {
      fixture.root.sessionCatalogStore
        .projectSessions("/other")
        .map(({ sessionId, title }) => [sessionId, title]);
      otherProjectDerivations += 1;
    });
    try {
      const updated = { ...original, title: "Updated", modifiedAt: "2026-01-03T00:00:00.000Z" };
      applySessionCatalogGroupUpdate(
        fixture.models.sessionCatalog,
        { projectPath, resolved: false },
        { _tag: "Event", revision: 1, event: { _tag: "Upserted", session: updated } },
      );
      applySessionCatalogGroupUpdate(
        fixture.models.sessionCatalog,
        { projectPath, resolved: false },
        {
          _tag: "Event",
          revision: 2,
          event: {
            _tag: "StatusChanged",
            sessionId: original.sessionId,
            resolved: true,
            unread: false,
          },
        },
      );
      applySessionCatalogGroupUpdate(
        fixture.models.sessionCatalog,
        { projectPath, resolved: true },
        {
          _tag: "Event",
          revision: 1,
          event: { _tag: "Upserted", session: { ...updated, resolved: true } },
        },
      );
      expect(otherProjectDerivations).toBe(1);
    } finally {
      stop();
    }
  });
});
