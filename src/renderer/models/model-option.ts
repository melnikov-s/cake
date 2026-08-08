import { Model, observable, state } from "r-state-tree";
import type { ModelOption } from "../../ipc/session-contract";

export class ModelOptionModel extends Model {
  @state provider = "";
  @state providerName = "";
  @state id = "";
  @state name = "";
  @state reasoning = false;
  @state input: ModelOption["input"] = observable([]);
  @state authenticated = false;
  @state authTypes: ModelOption["authTypes"] = observable([]);
}
