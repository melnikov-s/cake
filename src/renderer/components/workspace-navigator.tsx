import { observer, useStore } from "r-state-tree/react";
import { WidgetTabPicker } from "./widget-tab-picker";
import { RootStore } from "../stores/RootStore";
import { WorkspaceNavigatorContent } from "./workspace-navigator-content";
import { ActivityCount } from "./ui/activity-count";
import { SegmentedControlGroup, SegmentedControlButton } from "./ui/segmented-control";

/** One mutually-exclusive source-list accessory, independent of the focused work surface. */
export const WorkspaceNavigator = observer(function WorkspaceNavigator() {
  const root = useStore(RootStore);
  const navigator = root.workspaceNavigatorStore;
  const todos = navigator.todos;
  const sessions = root.conversationNavigatorStore.summaryCounts(navigator.projectPath);
  return (
    <aside
      id="workspace-navigator"
      data-slot="workspace-navigator"
      aria-label="Workspace"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-border/70 bg-sidebar text-sidebar-foreground select-none"
    >
      <header className="@container box-content flex h-title-bar shrink-0 items-center gap-1 border-b border-border/65 px-2">
        <SegmentedControlGroup
          className="grid min-w-0 flex-1 grid-cols-2"
          aria-label="Workspace content"
          size="sm"
        >
          <SegmentedControlButton
            active={!navigator.showingWidget && navigator.mode === "todos"}
            onClick={() => navigator.show("todos")}
            className="h-8 min-w-0 flex-col gap-0 whitespace-nowrap px-1 @min-[260px]:h-6 @min-[260px]:flex-row @min-[260px]:gap-1"
            size="sm"
          >
            <span>To-dos</span>{" "}
            <span className="text-muted-foreground tabular-nums">
              {todos?.openItems.length ?? 0}
            </span>
          </SegmentedControlButton>
          <SegmentedControlButton
            active={!navigator.showingWidget && navigator.mode === "sessions"}
            onClick={() => navigator.show("sessions")}
            aria-label={`Sessions · ${sessions.running} running · ${sessions.unread} unread`}
            title={`${sessions.running} running · ${sessions.unread} unread · ${sessions.total} total in ${navigator.projectPath ? "this project" : "all projects"}`}
            className="h-8 min-w-0 flex-col gap-0 whitespace-nowrap px-1 @min-[260px]:h-6 @min-[260px]:flex-row @min-[260px]:gap-1"
            size="sm"
          >
            <span>Sessions</span>{" "}
            <span className="inline-flex items-center gap-1">
              <ActivityCount count={sessions.running} />
              <ActivityCount kind="unread" count={sessions.unread} />
            </span>
          </SegmentedControlButton>
        </SegmentedControlGroup>
        <WidgetTabPicker />
      </header>
      <WorkspaceNavigatorContent />
    </aside>
  );
});
