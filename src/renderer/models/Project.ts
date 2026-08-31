import { Model, id } from "r-state-tree";
export class Project extends Model {
  @id path = "";
  name = "";
  addedAt = "";
  lastOpenedAt = "";
}
