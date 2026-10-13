import { widgetPackageSettingsOperations } from "../../contracts/application/agent-settings-schema";
import type { JsonObject, JsonValue } from "../../contracts/serialization/json-contract";
import { createCakeSettingsOperations } from "./cake-settings-operations";

export function createCakeWidgetPackageOperations(
  invoke: (command: string, input: JsonObject, signal: AbortSignal) => Promise<JsonValue>,
) {
  return createCakeSettingsOperations(invoke, widgetPackageSettingsOperations);
}
