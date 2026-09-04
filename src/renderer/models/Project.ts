import { Model, id } from "r-state-tree";
import { defaultProjectSettings, type ProjectSettings } from "../../domain/application-data";

export class Project extends Model {
  @id path = "";
  name = "";
  addedAt = "";
  lastOpenedAt = "";
  settings: ProjectSettings = defaultProjectSettings();
}
