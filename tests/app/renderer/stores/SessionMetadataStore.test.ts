import { applySnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Retained authority-join integration, not a GUI workflow: metadata can be read
// before session loading or between independent catalog/registry updates. There
// is no user action that deliberately makes those two sources disagree. Keep
// real Root providers and projections for precedence and fallback/removal policy.
// Resolved/restored presentation is already covered by session-metadata,
// session-management and workbench workflows; do not repeat their GUI journeys.
describe("Session metadata authority integration", () => {
  it("joins catalog-only and loaded-only identities, prefers authority and falls back after its removal", () => {
    const catalogOnly = sessionSummary({
      sessionId: "catalog",
      projectPath: "/project",
      workingDirectory: "/catalog",
    });
    using fixture = createRendererStoreFixture({ sessions: [catalogOnly] });
    const metadata = fixture.root.sessionMetadataStore;
    expect(metadata.workingDirectory("catalog")).toBe("/catalog");
    expect(metadata.exists("catalog")).toBe(true);
    expect(fixture.root.sessionRegistry.findSession("catalog")).toBeUndefined();
    expect(metadata.workingDirectory("missing")).toBeUndefined();
    expect(metadata.exists("missing")).toBe(false);

    const loaded = fixture.root.sessionRegistry.load("loaded", "/loaded");
    expect(metadata.workingDirectory("loaded")).toBe("/loaded");
    expect(metadata.exists("loaded")).toBe(true);

    // Catalog authority may be refreshed before the loaded identity catches up.
    applySnapshot(fixture.models.sessionCatalog, {
      sessions: [
        catalogOnly,
        sessionSummary({
          sessionId: "loaded",
          projectPath: "/project",
          workingDirectory: "/authoritative",
        }),
      ],
      resolvedHasMoreByProject: {},
    });
    expect(metadata.workingDirectory("loaded")).toBe("/authoritative");
    expect(loaded.workspacePath).toBe("/loaded");

    applySnapshot(fixture.models.sessionCatalog, {
      sessions: [catalogOnly],
      resolvedHasMoreByProject: {},
    });
    expect(metadata.workingDirectory("loaded")).toBe("/loaded");
    expect(metadata.exists("loaded")).toBe(true);
    fixture.root.sessionRegistry.removeSession("loaded");
    expect(metadata.workingDirectory("loaded")).toBeUndefined();
    expect(metadata.exists("loaded")).toBe(false);
  });
});
