import { Model, child, id, observable } from "r-state-tree";
import { SubagentActivity } from "./SubagentActivity";
import type { SubagentMetadata } from "../../contracts/subagents/subagent-data";

/** Focused Subagent activity projection for one parent Project Session. */
export class SubagentCatalog extends Model {
  @id sessionId = "";
  loaded = false;
  observationError: string | undefined;
  @child(SubagentActivity) activities: SubagentActivity[] = observable([]);
  releasedHandleIds: string[] = observable([]);
  backgroundActive = false;
  /** Cold navigation is independent from the full worker transcript projection. */
  metadataLoaded = false;
  metadata: SubagentMetadata[] = observable([]);
}
