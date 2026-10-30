import { Model, transient } from "r-state-tree";
import { emptyProjectTodos, type ProjectTodos } from "../../contracts/projects/project-todos";

/** Window projection of global Cake Chat's own to-do list from main-owned application state. */
export class CakeChatTodoList extends Model {
  revision = -1;
  todos: ProjectTodos = emptyProjectTodos();
  get selectedTodo() {
    return this.todos.items.find(
      (item) => item.id === this.todos.selectedId && item.state === "open" && !item.snoozedUntil,
    );
  }

  /** Live empty-list creation marker; snapshots/hydration never advance it. */
  @transient todoCreationRevision = 0;
}
