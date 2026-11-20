/**
 * How the Workspace tab strip narrows: widget tabs give up their titles first,
 * then To-dos/Sessions collapse to icons, and only then does the widget tab fold
 * into its chevron menu.
 */
export const workspaceTabStages = ["full", "widget-icons", "icons", "overflow"] as const;
export type WorkspaceTabStage = (typeof workspaceTabStages)[number];
/** Stages with a measured natural width; overflow is whatever remains. */
export type MeasuredWorkspaceTabStage = Exclude<WorkspaceTabStage, "overflow">;

/** Extra room required before widening a stage, so a pane resting on a threshold doesn't flicker. */
export const WORKSPACE_TAB_HYSTERESIS = 8;

/** Pick the widest stage whose natural width fits. Narrowing is immediate; widening needs a margin. */
export function chooseWorkspaceTabStage(
  available: number,
  required: Readonly<Record<MeasuredWorkspaceTabStage, number>>,
  current: WorkspaceTabStage,
): WorkspaceTabStage {
  const currentIndex = workspaceTabStages.indexOf(current);
  for (const [index, stage] of (["full", "widget-icons", "icons"] as const).entries()) {
    const margin = index < currentIndex ? WORKSPACE_TAB_HYSTERESIS : 0;
    if (required[stage] + margin <= available) return stage;
  }
  return "overflow";
}

export function workspaceTabPresentation(stage: WorkspaceTabStage) {
  return {
    widget: stage === "full" ? "full" : stage === "overflow" ? "menu" : "icon",
    builtIns: stage === "icons" || stage === "overflow" ? "icon" : "full",
  } as const;
}

export type WorkspaceTabPresentation = ReturnType<typeof workspaceTabPresentation>;
