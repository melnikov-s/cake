import { describe, expect, it } from "vitest";
import { ApplicationModel } from "../../../src/main/application-model";

describe("ApplicationModel", () => {
  it("owns project metadata and Cake-only session archive state", () => {
    const model = ApplicationModel.from({});
    const projects = model.projects;
    const trustedProjectPaths = model.trustedProjectPaths;
    const project = model.upsertProject("/work/cake", "cake");
    const archivedSessionIds = project.archivedSessionIds;
    model.trustProject("/work/cake");
    project.rename("Cake desktop");
    project.setSessionArchived("session-1", true);

    expect(model.snapshot()).toMatchObject({
      schemaVersion: 1,
      trustedProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake desktop", archivedSessionIds: ["session-1"] }]
    });

    project.setSessionArchived("session-1", false);
    model.removeProject("/work/cake");
    expect(model.projects).toBe(projects);
    expect(model.trustedProjectPaths).toBe(trustedProjectPaths);
    expect(project.archivedSessionIds).toBe(archivedSessionIds);
    expect(model.snapshot().projects).toEqual([]);
    expect(model.isProjectTrusted("/work/cake")).toBe(false);
  });

  it("persists an explicitly configured utility model without inventing a default", () => {
    const model = ApplicationModel.from({});
    expect(model.snapshot().utilityModel).toBeUndefined();

    model.setUtilityModel({ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" });
    expect(model.snapshot().utilityModel).toEqual({ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" });

    model.setUtilityModel(undefined);
    expect(model.snapshot().utilityModel).toBeUndefined();
  });
});
