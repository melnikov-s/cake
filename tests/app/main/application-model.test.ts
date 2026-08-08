import { describe, expect, it } from "vitest";
import { ApplicationModel } from "../../../src/main/application-model";

describe("ApplicationModel", () => {
  it("owns project metadata and Cake-only session archive state", () => {
    const model = ApplicationModel.from({});
    const project = model.upsertProject("/work/cake", "cake");
    project.rename("Cake desktop");
    project.setSessionArchived("session-1", true);

    expect(model.snapshot()).toMatchObject({
      schemaVersion: 1,
      projects: [{ path: "/work/cake", name: "Cake desktop", archivedSessionIds: ["session-1"] }]
    });

    project.setSessionArchived("session-1", false);
    model.removeProject("/work/cake");
    expect(model.snapshot().projects).toEqual([]);
  });
});
