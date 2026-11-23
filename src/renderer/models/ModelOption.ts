import { Model, computed, id, modelRef, observable } from "r-state-tree";
import type { ModelOption as ModelOptionRecord } from "../../contracts/conversations/session-contract";

import { LlmModel } from "./LlmModel";

/** A session runtime's availability and capabilities for a shared LLM identity. */
export class ModelOption extends Model {
  @id id = "";
  @modelRef(LlmModel) llmModel: LlmModel | undefined;
  // Snapshot hydration can notify readers of the whole option when an array
  // changes in place. Grouping should react only when these scalar results change.
  @computed
  get provider() {
    return this.llmModel?.provider ?? "";
  }

  @computed
  get connectedProvider() {
    return this.authenticated ? this.provider : undefined;
  }

  @computed
  get providerHeading() {
    return this.providerName;
  }

  get modelId() {
    return this.llmModel?.modelId ?? "";
  }

  providerName = "";
  name = "";
  reasoning = false;
  available: ModelOptionRecord["available"] = undefined;
  availableThinkingLevels: ModelOptionRecord["availableThinkingLevels"] = observable([]);
  fastMode = false;
  input: ModelOptionRecord["input"] = observable([]);
  authenticated = false;
  authSource: ModelOptionRecord["authSource"] = undefined;
  authLabel: ModelOptionRecord["authLabel"] = undefined;
  authTypes: ModelOptionRecord["authTypes"] = observable([]);
}
