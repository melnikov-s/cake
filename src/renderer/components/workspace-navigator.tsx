import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { WorkspaceNavigatorContent } from "./workspace-navigator-content";
import { ActivityCount } from "./ui/activity-count";
import { IconButton } from "./ui/icon-button";
import { CloseIcon } from "./ui/icons";
import { SegmentedControlGroup, SegmentedControlButton } from "./ui/segmented-control";

/** One mutually-exclusive source-list accessory, independent of the focused work surface. */
export const WorkspaceNavigator = observer(function WorkspaceNavigator() {
  const root = useStore(RootStore);
  const navigator = root.workspaceNavigatorStore;
  const todos = navigator.todos;
  const sessions = root.conversationNavigatorStore.tree(navigator.projectPath);
  return (
    <aside
      data-slot="workspace-navigator"
      aria-label="Workspace"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-border/70 bg-sidebar text-sidebar-foreground select-none"
    >
      <header className="flex h-title-bar shrink-0 items-center gap-1 px-2">
        <SegmentedControlGroup className="min-w-0 flex-1" aria-label="Workspace content" size="sm">
          <SegmentedControlButton
            active={navigator.mode === "todos"}
            onClick={() => navigator.show("todos")}
            className="flex-1 gap-1.5"
            size="sm"
          >
            To-dos{" "}
            <span className="text-muted-foreground tabular-nums">
              {todos?.openItems.length ?? 0}
            </span>
          </SegmentedControlButton>
          <SegmentedControlButton
            active={navigator.mode === "sessions"}
            onClick={() => navigator.show("sessions")}
            aria-label={`Sessions · ${sessions.running} running`}
            title={`${sessions.running} running · ${sessions.total} total in ${navigator.projectPath ? "this project" : "Cake Chat"} (including side chats and subagents)`}
            className="min-w-0 flex-1 gap-1.5 whitespace-nowrap"
            size="sm"
          >
            Sessions <ActivityCount count={sessions.running} />
          </SegmentedControlButton>
        </SegmentedControlGroup>
        <IconButton tooltip="Close Workspace" onClick={() => navigator.close()}>
          <CloseIcon />
        </IconButton>
      </header>
      <WorkspaceNavigatorContent />
    </aside>
  );
});
