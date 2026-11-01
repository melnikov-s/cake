import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../../contracts/serialization/json-contract";
import {
  themeControlOutput,
  themeOperationDefinitions,
} from "../../contracts/themes/theme-operations";

/** Both permanent chat gateways and coding sessions use the same typed window authority. */
export function createCakeThemeOperations(
  invoke: (command: string, input: JsonObject, signal: AbortSignal) => Promise<JsonValue>,
): CakeOperationDefinition[] {
  return Object.values(themeOperationDefinitions).map((definition) => ({
    command: definition.command,
    requires: "invokeAppControl",
    topic: definition.discovery.topic,
    summary: definition.discovery.summary,
    guidance: definition.discovery.guidance,
    inputSchema: definition.args,
    outputSchema: themeControlOutput(definition),
    examples: "examples" in definition.discovery ? [...definition.discovery.examples] : [],
    result:
      "Persisted per-window theme catalog and effective appearance. Failure returns {ok:false,error}; invalid input or unavailable desktop control may throw. Mutations acknowledge only after window-state persistence completes.",
    async execute(input, context) {
      context.signal.throwIfAborted();
      return invoke(
        definition.command,
        await Schema.decodeUnknownPromise(jsonObjectSchema)(input),
        context.signal,
      );
    },
  }));
}
