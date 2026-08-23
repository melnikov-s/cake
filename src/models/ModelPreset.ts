import { Model, id } from "r-state-tree";
import type { ModelPreset as ModelPresetSnapshot } from "../ipc/session-contract";

/** A user-named, persisted chat runtime configuration. */
export class ModelPreset extends Model {
  @id id = "";
  name = "";
  provider = "";
  modelId = "";
  thinkingLevel: ModelPresetSnapshot["thinkingLevel"] = "off";
  fastMode = false;
}
