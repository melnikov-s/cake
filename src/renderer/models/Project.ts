import { Model, id } from "r-state-tree";
import {
  defaultProjectSettings,
  defaultProjectWorkflow,
  type ProjectSettings,
  type ProjectWorkflow,
} from "../../domain/application-data";

export class Project extends Model {
  @id path = "";
  name = "";
  addedAt = "";
  lastOpenedAt = "";
  settings: ProjectSettings = defaultProjectSettings();
  workflow: ProjectWorkflow = defaultProjectWorkflow();
}
