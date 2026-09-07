import { Model, child, observable } from "r-state-tree";
import { CakeChatSummary } from "./CakeChatSummary";

/** Passive current Cake Chat catalog projection. */
export class CakeChatCatalog extends Model {
  loaded = false;
  resolvedHasMore = false;
  @child(CakeChatSummary) sessions: CakeChatSummary[] = observable([]);

  find(sessionId: string) {
    return this.sessions.find((session) => session.sessionId === sessionId);
  }
}
