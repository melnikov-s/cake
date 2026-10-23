import { Model, child, id, observable } from "r-state-tree";
import { SubagentActivity } from "./SubagentActivity";

/** Focused Subagent activity projection for one parent Project Session. */
export class SubagentCatalog extends Model {
  @id sessionId = "";
  loaded = false;
  observationError: string | undefined;
  @child(SubagentActivity) activities: SubagentActivity[] = observable([]);
  releasedHandleIds: string[] = observable([]);
  backgroundActive = false;
}
