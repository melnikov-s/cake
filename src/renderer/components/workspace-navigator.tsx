import { observer, useStore } from "r-state-tree/react";
import { WorkspaceTabStrip } from "./workspace-tab-strip";
import { RootStore } from "../stores/RootStore";
import { WorkspaceNavigatorContent } from "./workspace-navigator-content";
import { ActivityCount } from "./ui/activity-count";
import { CountBadge } from "./ui/count-badge";
import { SessionsIcon, TodoIcon } from "./ui/icons";
import { cn } from "../lib/utils";

/** One mutually-exclusive source-list accessory, independent of the focused work surface. */
export const WorkspaceNavigator = observer(function WorkspaceNavigator() {
  const root = useStore(RootStore);
  const navigator = root.workspaceNavigatorStore;
  const todoCount = navigator.todos?.paneOpenCount ?? 0;
  const sessions = root.conversationNavigatorStore.summaryCounts();
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
        <header className="@container flex h-11 shrink-0 items-center border-b border-hairline-subtle px-3.5">
          <WorkspaceTabStrip
            label="Workspace content"
            tabs={[
              {
                id: "todos",
                label: "To-dos",
                icon: <TodoIcon />,
                active: todosActive,
                onSelect: () => navigator.show("todos"),
                ariaLabel: `To-dos ${todoCount}`,
                title: `To-dos · ${todoCount} open`,
                counts: (
                  <span
                    className={cn(
                      "tabular-nums",
                      todosActive ? "text-accent/85" : "text-muted-foreground",
                    )}
                  >
                    {todoCount}
                  </span>
                ),
                badges: <CountBadge count={todoCount} tone={todosActive ? "accent" : "neutral"} />,
              },
              {
                id: "sessions",
                label: "Sessions",
                icon: <SessionsIcon />,
                active: sessionsActive,
                onSelect: () => navigator.show("sessions"),
                ariaLabel: `Sessions · ${sessions.running} running · ${sessions.unread} unread`,
                title: `${sessions.running} running · ${sessions.unread} unread · ${sessions.total} total in all projects`,
                counts: (
                  <span className="inline-flex items-center gap-1">
                    <ActivityCount count={sessions.running} />
                    <ActivityCount kind="unread" count={sessions.unread} />
                  </span>
                ),
                badges: (
                  <>
                    <ActivityCount compact count={sessions.running} />
                    <ActivityCount compact kind="unread" count={sessions.unread} />
                  </>
                ),
              },
            ]}
          />
        </header>
        <WorkspaceNavigatorContent />
      </div>
    </aside>
  );
});
