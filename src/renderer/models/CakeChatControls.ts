import { Model, id, observable } from "r-state-tree";
import type { CakeChatControlRequest } from "../../contracts/cake-chats/cake-chat-data";

/** Focused application-control request projection for one Cake Chat Session. */
export class CakeChatControls extends Model {
  @id sessionId = "";
  requests: CakeChatControlRequest[] = observable([]);
}
