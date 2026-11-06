import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { NumberedIconButton } from "./ui/numbered-icon-button";
import { CheckIcon } from "./ui/icons";

export const WorkspaceTodosToggle = observer(function WorkspaceTodosToggle() {
  const navigator = useStore(RootStore).workspaceNavigatorStore;
  const todos = navigator.todos;
  if (!todos?.available) return null;
  return (
    <NumberedIconButton
      tooltip="To-dos"
      count={todos.openItems.length}
      aria-description={`${todos.openItems.length} open to-dos`}
      pressedAppearance="subtle"
      viewFocused={todos.focusedItems.length > 0}
      aria-pressed={navigator.visible && navigator.mode === "todos"}
      onClick={() => navigator.toggle("todos")}
    >
      <CheckIcon />
    </NumberedIconButton>
  );
});
