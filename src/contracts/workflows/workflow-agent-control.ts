import type { JsonObject, JsonValue } from "../serialization/json-contract";

export interface WorkflowControl {
  isEnabled(): boolean;
  invoke(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
}
