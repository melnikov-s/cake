import { describe, expect, it } from "vitest";
import { sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// These tests exercise the pure metadata joins with the production Root providers.
describe("SessionMetadataStore joins", () => {
  it("reads catalog-only sessions without loading their Stores", () => {
    using fixture = createRendererStoreFixture({
      sessions: [
        sessionSummary({
          sessionId: "catalog",
          projectPath: "/project",
          workingDirectory: "/catalog",
        }),
      ],
    });
    const metadata = fixture.root.sessionMetadataStore;
    expect(metadata.workingDirectory("catalog")).toBe("/catalog");
    expect(metadata.exists("catalog")).toBe(true);
    expect(metadata.isResolved("catalog")).toBe(false);
    expect(fixture.root.sessionRegistry.findSession("catalog")).toBeUndefined();
    expect(metadata.workingDirectory("missing")).toBeUndefined();
    expect(metadata.exists("missing")).toBe(false);
    expect(metadata.isResolved("missing")).toBe(false);
  });

  it("falls back to a loaded-only session and follows its removal", () => {
    using fixture = createRendererStoreFixture();
    fixture.root.sessionRegistry.load("loaded", "/loaded");
    const metadata = fixture.root.sessionMetadataStore;
    expect(metadata.workingDirectory("loaded")).toBe("/loaded");
    expect(metadata.exists("loaded")).toBe(true);
    expect(metadata.isResolved("loaded")).toBe(false);
    fixture.root.sessionRegistry.removeSession("loaded");
    expect(metadata.workingDirectory("loaded")).toBeUndefined();
    expect(metadata.exists("loaded")).toBe(false);
  });

  it("prefers the authoritative catalog Working Directory when both sources contain a session", () => {
    using fixture = createRendererStoreFixture({
      sessions: [
        sessionSummary({ sessionId: "both", projectPath: "/project", workingDirectory: "/loaded" }),
      ],
    });
    fixture.root.sessionRegistry.load("both", "/loaded");
    // A catalog refresh may arrive before the existing loaded identity is relocated.
    fixture.models.sessionCatalog.find("both")!.workingDirectory = "/catalog";
    const metadata = fixture.root.sessionMetadataStore;
    expect(metadata.workingDirectory("both")).toBe("/catalog");
    expect(metadata.exists("both")).toBe(true);
    expect(fixture.root.sessionRegistry.findSession("both")!.workspacePath).toBe("/loaded");
  });

  it("reads resolution only from the catalog and follows restore transitions", () => {
    using fixture = createRendererStoreFixture({
      sessions: [
        sessionSummary({ sessionId: "resolved", projectPath: "/project", resolved: true }),
      ],
    });
    const metadata = fixture.root.sessionMetadataStore;
    expect(metadata.isResolved("resolved")).toBe(true);
    fixture.root.sessionRegistry.load("resolved", "/project");
    expect(metadata.isResolved("resolved")).toBe(true);
    fixture.models.sessionCatalog.find("resolved")!.resolved = false;
    expect(metadata.isResolved("resolved")).toBe(false);
  });
});
