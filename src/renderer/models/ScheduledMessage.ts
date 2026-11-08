import { Model, id } from "r-state-tree";

/** Passive renderer projection of one Cake-owned scheduled message. */
export class ScheduledMessage extends Model {
  @id id = "";
  targetSessionId = "";
  text = "";
  sendAt = "";
  createdAt = "";
  pendingOccurrenceId: string | undefined;
  cancelRequested: boolean | undefined;
  deliveryError: string | undefined;
  createdBySessionId: string | undefined;
  repeatEverySeconds: number | undefined;
  repeatUntil: string | undefined;
}
