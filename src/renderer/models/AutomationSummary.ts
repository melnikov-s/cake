import { Model, id } from "r-state-tree";
import type {
  AutomationContext,
  AutomationId,
  AutomationState,
  AutomationActivity,
} from "../../contracts/automations/automation-data";

/** Passive management projection; saved definitions are not sessions. */
export class AutomationSummary extends Model {
  @id id: AutomationId | undefined;
  name = "";
  context: AutomationContext = { _tag: "Global" };
  state: AutomationState = { _tag: "paused" };
  activity: AutomationActivity = { runningSessions: 0, queuedOccurrences: 0 };
  nextScheduledAt: string | undefined;
}
