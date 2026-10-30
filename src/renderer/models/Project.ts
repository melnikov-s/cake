import { emptyProjectTodos, type ProjectTodos } from "../../contracts/projects/project-todos";
import { Model, id, transient } from "r-state-tree";
import {
  defaultProjectSettings,
  defaultProjectWorkflow,
  type ProjectSettings,
  type ProjectWorkflow,
} from "../../contracts/application/application-data";

export class Project extends Model {
  @id path = "";
  name = "";
  addedAt = "";
  lastOpenedAt = "";
  settings: ProjectSettings = defaultProjectSettings();
  workflow: ProjectWorkflow = defaultProjectWorkflow();
  todos: ProjectTodos = emptyProjectTodos();
  get selectedTodo() {
    return this.todos.items.find(
      (item) => item.id === this.todos.selectedId && item.state === "open" && !item.snoozedUntil,
    );
  }

  /** Live empty-list creation marker; snapshots/hydration never advance it. */
  @transient todoCreationRevision = 0;
}
