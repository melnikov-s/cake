import { Model, child, id, observable } from "r-state-tree";
import { ScheduledMessage } from "./ScheduledMessage";

/** Focused Cake-owned Scheduled Message projection for one Project Session. */
export class ScheduledMessageCatalog extends Model {
  @id sessionId = "";
  @child(ScheduledMessage) messages: ScheduledMessage[] = observable([]);
}
