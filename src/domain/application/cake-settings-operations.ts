import { Schema } from "effect";
import {
  agentSettingsOperations,
  settingsOperationGuidance,
} from "../../contracts/application/agent-settings-schema";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../../contracts/serialization/json-contract";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

export function createCakeSettingsOperations(
  invoke: (command: string, input: JsonObject, signal: AbortSignal) => Promise<JsonValue>,
  operations: readonly (typeof agentSettingsOperations)[number][] = agentSettingsOperations.filter(
    (operation) => !operation.command.startsWith("settings.widgets."),
  ),
): CakeOperationDefinition[] {
  return operations.map((operation) => ({
    command: operation.command,
    requires: "invokeAppControl",
    topic: "settings",
    summary: operation.summary,
    guidance: settingsOperationGuidance(operation),
    inputSchema: operation.input,
    outputSchema: Schema.Union([
      Schema.Struct({
        ok: Schema.Literal(true),
        command: Schema.Literal(operation.command),
        value: operation.output,
      }),
      Schema.Struct({
        ok: Schema.Literal(false),
        command: Schema.optionalKey(Schema.String),
        error: Schema.String,
      }),
    ]),
    examples: [{ input: operation.example }],
    result:
      "Structured {ok, command, value} from the existing Settings authority; control failures return {ok:false,error}. Malformed input and cancelled waits may throw. Cancellation never confirms authorization or undoes an already-committed setting.",
    async execute(input, context) {
      context.signal.throwIfAborted();
      return invoke(
        operation.command,
        await Schema.decodeUnknownPromise(jsonObjectSchema)(input),
        context.signal,
      );
    },
  }));
}
