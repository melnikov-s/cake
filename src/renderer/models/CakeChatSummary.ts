import { Model, id } from "r-state-tree";

/** Passive renderer projection of one authoritative Cake Chat catalog entry. */
export class CakeChatSummary extends Model {
  @id sessionId = "";
  title = "";
  createdAt = "";
  modifiedAt = "";
  messageCount = 0;
  parentSessionId: string | undefined;
  resolved = false;
}
