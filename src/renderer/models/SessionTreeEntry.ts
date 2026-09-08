import { Model, id } from "r-state-tree";

export class SessionTreeEntry extends Model {
  @id id = "";
  piId = "";
  parentPiId: string | undefined;
  type = "";
  messageRole: string | undefined;
  editorText: string | undefined;
  label: string | undefined;
  preview = "";
  active = false;
}
