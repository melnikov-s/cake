import { emptyProjectTodos, type ProjectTodos } from "../../contracts/projects/project-todos";
import { Model, id } from "r-state-tree";
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
}
