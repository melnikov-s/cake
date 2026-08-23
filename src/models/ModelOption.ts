import { Model, id, observable } from "r-state-tree";
import type { ModelOption as ModelOptionRecord } from "../ipc/session-contract";

export class ModelOption extends Model {
  @id key = "";
  provider = "";
  providerName = "";
  id = "";
  name = "";
  reasoning = false;
  availableThinkingLevels: ModelOptionRecord["availableThinkingLevels"] = observable([]);
  fastMode = false;
  input: ModelOptionRecord["input"] = observable([]);
  authenticated = false;
  authSource: ModelOptionRecord["authSource"] = undefined;
  authLabel: ModelOptionRecord["authLabel"] = undefined;
  authTypes: ModelOptionRecord["authTypes"] = observable([]);
}
