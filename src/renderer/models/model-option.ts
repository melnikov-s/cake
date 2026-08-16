import { Model, id, observable, state } from "r-state-tree";
import type { ModelOption } from "../../ipc/session-contract";

export class ModelOptionModel extends Model {
  @id key = "";
  @state provider = "";
  @state providerName = "";
  @state id = "";
  @state name = "";
  @state reasoning = false;
  @state input: ModelOption["input"] = observable([]);
  @state authenticated = false;
  @state authSource: ModelOption["authSource"] = undefined;
  @state authLabel: ModelOption["authLabel"] = undefined;
  @state authTypes: ModelOption["authTypes"] = observable([]);
}

export function modelOptionKey(option: Pick<ModelOption, "provider" | "id">) {
  return JSON.stringify([option.provider, option.id]);
}
