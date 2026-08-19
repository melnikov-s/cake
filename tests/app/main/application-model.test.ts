import { describe, expect, it } from "vitest";
import { ApplicationModel } from "../../../src/main/application-model";

describe("ApplicationModel", () => {
  it("owns project metadata and Cake-only session resolve state", () => {
    const model = ApplicationModel.from({});
    const projects = model.projects;
    const trustedProjectPaths = model.trustedProjectPaths;
    const project = model.upsertProject("/work/cake", "cake");
    const resolvedSessionIds = model.resolvedSessionIds;
    model.trustProject("/work/cake");
    project.rename("Cake desktop");
    model.setSessionsResolved(["session-1"], true);
    model.setCakeChatSessionResolved("cake-chat-1", true);

    expect(model.snapshot()).toMatchObject({
      schemaVersion: 1,
      resolvedCakeChatSessionIds: ["cake-chat-1"],
      trustedProjectPaths: ["/work/cake"],
      projects: [{ path: "/work/cake", name: "Cake desktop" }],
      resolvedSessionIds: ["session-1"],
    });

    model.setSessionsResolved(["session-1"], false);
    model.setCakeChatSessionResolved("cake-chat-1", false);
    model.removeProject("/work/cake");
    expect(model.projects).toBe(projects);
    expect(model.trustedProjectPaths).toBe(trustedProjectPaths);
    expect(model.resolvedSessionIds).not.toBe(resolvedSessionIds);
    expect(model.snapshot().projects).toEqual([]);
    expect(model.snapshot().resolvedCakeChatSessionIds).toEqual([]);
    expect(model.isProjectTrusted("/work/cake")).toBe(false);
  });

  it("persists an explicitly configured utility model without inventing a default", () => {
    const model = ApplicationModel.from({});
    expect(model.snapshot().utilityModel).toBeUndefined();

    model.setUtilityModel({ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "low" });
    expect(model.snapshot().utilityModel).toEqual({
      provider: "openai",
      modelId: "gpt-5-mini",
      thinkingLevel: "low",
    });

    model.setUtilityModel(undefined);
    expect(model.snapshot().utilityModel).toBeUndefined();
  });

  it("updates resolve state on projects restored from persistence", () => {
    const model = ApplicationModel.from({
      schemaVersion: 1,
      projects: [
        {
          path: "/work/cake",
          name: "Cake",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    });

    model.upsertProject("/work/cake", "Cake");
    model.setSessionsResolved(["session-1", "session-2"], true);

    expect(model.snapshot().resolvedSessionIds).toEqual(["session-1", "session-2"]);
    model.setSessionsResolved(["session-1", "session-2"], false);
    expect(model.snapshot().resolvedSessionIds).toEqual([]);
  });
});
