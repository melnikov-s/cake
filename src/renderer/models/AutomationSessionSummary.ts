import { Model, id } from "r-state-tree";
import type { AutomationSessionIdentity } from "../../contracts/automations/automation-data";

/** A real regular-Pi automation conversation, independent of Project Session identity. */
export class AutomationSessionSummary extends Model {
  @id sessionId = "";
  identity: AutomationSessionIdentity | undefined;
  title = "";
  createdAt = "";
  modifiedAt = "";
  resolved = false;
  unread = false;
  running = false;
}
