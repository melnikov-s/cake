import { describe, expect, it } from "vitest";
import {
  WORKSPACE_TAB_HYSTERESIS,
  chooseWorkspaceTabStage,
  workspaceTabPresentation,
  workspaceTabStages,
  type WorkspaceTabStage,
} from "../../../src/renderer/lib/workspace-tab-stage";

const required = { full: 400, "widget-icons": 300, icons: 200 };

/** Drag the pane edge one pixel at a time, as a resize does, and record each stage change. */
function sweep(from: number, to: number, start: WorkspaceTabStage) {
  const step = from > to ? -1 : 1;
  let stage = start;
  const changes: Array<[number, WorkspaceTabStage]> = [];
  for (let width = from; width !== to + step; width += step) {
    const next = chooseWorkspaceTabStage(width, required, stage);
    if (next !== stage) changes.push([width, next]);
    stage = next;
  }
  return changes;
}

describe("Workspace tab collapse stages", () => {
  it("shrinks full → widget icons → all icons → overflow at the exact fit", () => {
    expect(chooseWorkspaceTabStage(500, required, "full")).toBe("full");
    expect(sweep(500, 100, "full")).toEqual([
      [399, "widget-icons"],
      [299, "icons"],
      [199, "overflow"],
    ]);
  });

  it("widens only after a hysteresis margin, so a pane resting on a threshold does not flicker", () => {
    const margin = WORKSPACE_TAB_HYSTERESIS;
    expect(margin).toBeGreaterThan(0);
    expect(sweep(100, 500, "overflow")).toEqual([
      [200 + margin, "icons"],
      [300 + margin, "widget-icons"],
      [400 + margin, "full"],
    ]);
    // One-pixel jitter around a threshold never toggles the stage.
    let stage: WorkspaceTabStage = "widget-icons";
    for (const width of [399, 400, 401, 399, 400, 405]) {
      stage = chooseWorkspaceTabStage(width, required, stage);
      expect(stage).toBe("widget-icons");
    }
  });

  it("jumps straight to the stage that fits when the pane shrinks a lot at once", () => {
    expect(chooseWorkspaceTabStage(150, required, "full")).toBe("overflow");
    expect(chooseWorkspaceTabStage(250, required, "full")).toBe("icons");
  });

  it("collapses widget tabs before To-dos/Sessions and uses the menu only last", () => {
    expect(workspaceTabStages.map(workspaceTabPresentation)).toEqual([
      { widget: "full", builtIns: "full" },
      { widget: "icon", builtIns: "full" },
      { widget: "icon", builtIns: "icon" },
      { widget: "menu", builtIns: "icon" },
    ]);
  });
});
