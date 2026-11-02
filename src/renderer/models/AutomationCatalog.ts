import { Model, child, observable, transient } from "r-state-tree";
import { AutomationSummary } from "./AutomationSummary";
import { AutomationSessionSummary } from "./AutomationSessionSummary";

export class AutomationCatalog extends Model {
  @transient loaded = false;
  @transient observationError: string | undefined;
  revision = 0;
  @child(AutomationSummary) automations: AutomationSummary[] = observable([]);
  @child(AutomationSessionSummary) unresolvedSessions: AutomationSessionSummary[] = observable([]);
}
