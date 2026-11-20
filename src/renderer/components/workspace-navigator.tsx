import { observer, useStore } from "r-state-tree/react";
import { WidgetTabPicker } from "./widget-tab-picker";
import { RootStore } from "../stores/RootStore";
import { WorkspaceNavigatorContent } from "./workspace-navigator-content";
import { ActivityCount } from "./ui/activity-count";
import { cn } from "../lib/utils";

const tabPillClassName = (active: boolean) =>
  cn(
    "inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40",
    active
      ? "border-accent/35 bg-accent/15 font-semibold text-accent"
      : "border-transparent font-medium text-muted-foreground hover:bg-foreground/[0.055] hover:text-foreground",
  );

/** One mutually-exclusive source-list accessory, independent of the focused work surface. */
export const WorkspaceNavigator = observer(function WorkspaceNavigator() {
  const root = useStore(RootStore);
  const navigator = root.workspaceNavigatorStore;
  const todos = navigator.todos;
  const sessions = root.conversationNavigatorStore.summaryCounts(navigator.projectPath);
  const commandVisible =
    Boolean(root.projectWorkbenchStore.commandPaneStore.pane) &&
    !root.appShellStore.applicationSurface;
  const todosActive = !navigator.showingWidget && navigator.mode === "todos";
  const sessionsActive = !navigator.showingWidget && navigator.mode === "sessions";
  return (
    <aside
      id="workspace-navigator"
      data-slot="workspace-navigator"
      aria-label="Workspace"
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col bg-chassis pb-2 pl-1 select-none max-[700px]:p-0",
        commandVisible ? "pr-1" : "pr-2",
      )}
    >
      <div
        data-slot="workspace-navigator-surface"
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-hairline bg-inspector text-sidebar-foreground shadow-[inset_0_1px_0_var(--surface-rim),var(--pane-shadow)] max-[700px]:rounded-none max-[700px]:border-0 max-[700px]:shadow-none"
      >
        <header className="@container flex h-11 shrink-0 items-center justify-between gap-1.5 border-b border-hairline-subtle px-3.5">
          <div
            role="group"
            aria-label="Workspace content"
            className="flex min-w-0 items-center gap-1.5"
          >
            <button
              type="button"
              aria-pressed={todosActive}
              onClick={() => navigator.show("todos")}
              className={tabPillClassName(todosActive)}
            >
              <span>To-dos</span>{" "}
              <span
                className={cn(
                  "tabular-nums",
                  todosActive ? "text-accent/85" : "text-muted-foreground",
                )}
              >
                {todos?.paneOpenCount ?? 0}
              </span>
            </button>
            <button
              type="button"
              aria-pressed={sessionsActive}
              onClick={() => navigator.show("sessions")}
              aria-label={`Sessions · ${sessions.running} running · ${sessions.unread} unread`}
              title={`${sessions.running} running · ${sessions.unread} unread · ${sessions.total} total in ${navigator.projectPath ? "this project" : "all projects"}`}
              className={tabPillClassName(sessionsActive)}
            >
              <span>Sessions</span>{" "}
              <span className="inline-flex items-center gap-1">
                <ActivityCount count={sessions.running} />
                <ActivityCount kind="unread" count={sessions.unread} />
              </span>
            </button>
          </div>
          <WidgetTabPicker />
        </header>
        <WorkspaceNavigatorContent />
      </div>
    </aside>
  );
});
