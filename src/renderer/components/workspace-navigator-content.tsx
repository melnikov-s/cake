import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ConversationNavigator } from "./conversation-navigator";
import { ProjectTodosPanel } from "./project-todos-panel";
import { SearchInput } from "./ui/search-input";

/** The same project-scoped navigation content in chat and tool workspaces. */
export const WorkspaceNavigatorContent = observer(function WorkspaceNavigatorContent() {
  const navigator = useStore(RootStore).workspaceNavigatorStore;
  const todos = navigator.todos;
  return navigator.mode === "sessions" ? (
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
  );
});
