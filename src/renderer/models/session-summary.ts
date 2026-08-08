import { Model, id, state } from "r-state-tree";

export class SessionSummaryModel extends Model {
  @id id = "";
  @state title = "";
  @state created = "";
  @state modified = "";
  @state messageCount = 0;
  @state parentSessionId: string | undefined;
  @state archived = false;
}
