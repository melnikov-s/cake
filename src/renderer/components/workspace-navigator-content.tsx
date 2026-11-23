import { observer, useStore } from "r-state-tree/react";
import { WidgetTabViewport } from "./widget-tab-viewport";
import { RootStore } from "../stores/RootStore";
import { ConversationNavigator } from "./conversation-navigator";
import { ProjectTodoFilterBar } from "./project-todo-filter-bar";
import { ProjectTodosPanel } from "./project-todos-panel";
import { SearchInput } from "./ui/search-input";

/** The same workspace navigation content in chat and tool workspaces. */
export const WorkspaceNavigatorContent = observer(function WorkspaceNavigatorContent() {
  const navigator = useStore(RootStore).workspaceNavigatorStore;
  if (navigator.showingWidget) return <WidgetTabViewport />;
  const todos = navigator.todos;
  return navigator.mode === "sessions" ? (
    <ConversationNavigator projectPath={navigator.projectPath} />
  ) : todos ? (
    <>
      <div className="px-3.5 pt-3 pb-2 [&_svg]:size-3">
        <SearchInput
          label="Search to-dos"
          placeholder="Search titles, updates, or reasons…"
          value={todos.query}
          onValueChange={(query) => todos.setQuery(query)}
          inputClassName="h-[31px] rounded-[9px] border-hairline-subtle bg-recessed shadow-none focus-visible:border-accent/35 focus-visible:ring-accent/15"
        />
      </div>
      <ProjectTodoFilterBar store={todos} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ProjectTodosPanel store={todos} />
      </div>
    </>
  ) : (
    <div className="p-4 text-sm text-muted-foreground">No to-dos.</div>
  );
});
