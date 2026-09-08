import { Model, id, modelRef, observable } from "r-state-tree";
import type { ModelOption as ModelOptionRecord } from "../../ipc/session-contract";

import { LlmModel } from "./LlmModel";

/** A session runtime's availability and capabilities for a shared LLM identity. */
export class ModelOption extends Model {
  @id id = "";
  @modelRef(LlmModel) llmModel: LlmModel | undefined;
  get provider() {
    return this.llmModel?.provider ?? "";
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
  get value(): ModelOptionRecord {
    return {
      provider: this.provider,
      id: this.llmModel?.modelId ?? "",
      name: this.name,
      providerName: this.providerName,
      reasoning: this.reasoning,
      available: this.available,
      availableThinkingLevels: this.availableThinkingLevels.slice(),
      fastMode: this.fastMode,
      input: this.input.slice(),
      authenticated: this.authenticated,
      authSource: this.authSource,
      authLabel: this.authLabel,
      authTypes: this.authTypes.slice(),
    };
  }
}
