import { Model, id, state } from "r-state-tree";
import { displaySessionTitle } from "./session-title";

export class SessionSummaryModel extends Model {
  @id id = "";
  @state title = "";
  @state created = "";
  @state modified = "";
  @state messageCount = 0;
  @state parentSessionId: string | undefined;
  @state archived = false;

  get displayTitle() {
    return displaySessionTitle(this.title);
  }
}
