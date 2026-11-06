import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ConversationNavigator } from "./conversation-navigator";
import { ProjectTodosPanel } from "./project-todos-panel";
import { IconButton } from "./ui/icon-button";
import { CloseIcon } from "./ui/icons";
import { SearchInput } from "./ui/search-input";
import { SegmentedControlGroup, SegmentedControlButton } from "./ui/segmented-control";

/** One mutually-exclusive source-list accessory, independent of the focused work surface. */
export const WorkspaceNavigator = observer(function WorkspaceNavigator() {
  const root = useStore(RootStore);
  const navigator = root.workspaceNavigatorStore;
  const todos = navigator.todos;
  const sessions = root.conversationNavigatorStore.countFor(navigator.projectPath);
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
            className="flex-1 gap-1.5"
            size="sm"
          >
            Sessions <span className="text-muted-foreground tabular-nums">{sessions}</span>
          </SegmentedControlButton>
        </SegmentedControlGroup>
        <IconButton tooltip="Close Workspace" onClick={() => navigator.close()}>
          <CloseIcon />
        </IconButton>
      </header>
      {navigator.mode === "sessions" ? (
        <ConversationNavigator projectPath={navigator.projectPath} />
      ) : todos ? (
        <>
          <div className="px-3 pb-2">
            <SearchInput
              label="Search to-dos"
              value={todos.query}
              onValueChange={(query) => todos.setQuery(query)}
            />
          </div>
          <div className="min-h-0 flex-1">
            <ProjectTodosPanel store={todos} />
          </div>
        </>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">No to-dos.</div>
      )}
    </aside>
  );
});
