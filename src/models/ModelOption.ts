import { Model, id, observable, state } from "r-state-tree";
import type { ModelOption as ModelOptionRecord } from "../ipc/session-contract";

export class ModelOption extends Model {
  @id key = "";
  @state provider = "";
  @state providerName = "";
  @state id = "";
  @state name = "";
  @state reasoning = false;
  @state input: ModelOptionRecord["input"] = observable([]);
  @state authenticated = false;
  @state authSource: ModelOptionRecord["authSource"] = undefined;
  @state authLabel: ModelOptionRecord["authLabel"] = undefined;
  @state authTypes: ModelOptionRecord["authTypes"] = observable([]);
}
