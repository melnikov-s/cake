import { Model, id, state } from "r-state-tree";

export class SessionTreeEntryModel extends Model {
  @id id = "";
  @state parentId: string | undefined;
  @state type = "";
  @state messageRole: string | undefined;
  @state editorText: string | undefined;
  @state label: string | undefined;
  @state preview = "";
  @state active = false;
}
