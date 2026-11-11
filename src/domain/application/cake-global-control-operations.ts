import { Schema } from "effect";
import {
  SessionCompactionOutput,
  sessionCompactionDefinitions,
} from "../../contracts/project-sessions/session-compaction";
import {
  CakeModelSelection,
  type ExplicitCakeModelSelection,
} from "../../contracts/model-presets/cake-model-selection";
import { jsonObjectSchema } from "../../contracts/serialization/json-contract";
import type { GlobalOperationControl } from "../../contracts/agent/cake-operation-options";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { createCakeThemeOperations } from "./cake-theme-operations";
import { createCakeSettingsOperations } from "./cake-settings-operations";
import { createSessionSendBatchOperation } from "../conversations/cake-session-batch-send-operation";

export function createGlobalControlOperations(
  control: GlobalOperationControl,
  resolveModel: (selection: CakeModelSelection | undefined) => ExplicitCakeModelSelection,
): CakeOperationDefinition[] {
  const invoke = (
    command: string,
    input: Schema.Schema.Type<typeof jsonObjectSchema>,
    signal: AbortSignal,
  ) => control.invoke({ name: command, arguments: input }, signal);
  const typedControls = [
    ...createCakeSettingsOperations(invoke),
    ...createCakeThemeOperations(invoke),
  ];
  const operations: CakeOperationDefinition[] = control.tools.map(
    (tool) =>
      typedControls.find((operation) => operation.command === tool.command) ?? {
        command: tool.command,
        canonicalSessionIds: ["sessions.list", "sessions.reports.read", "sessions.send"].includes(
          tool.command,
        ),
        topic: tool.topic,
        summary: tool.summary,
        guidance: tool.guidance,
        inputSchema: jsonObjectSchema,
        inputJsonSchema: tool.parameters,
        ...(sessionCompactionDefinitions.some((definition) => definition.command === tool.command)
          ? { outputSchema: SessionCompactionOutput }
          : null),
        examples: tool.examples ?? [],
        result: tool.result ?? "A bounded result from Cake's authoritative application control.",
        limitations: tool.limitations,
        async execute(input, context) {
          const decodedInput = Schema.decodeUnknownSync(jsonObjectSchema)(input);
          const argumentsValue = ["sessions.create", "sessions.create-draft"].includes(tool.command)
            ? {
                ...decodedInput,
                model: resolveModel(
                  decodedInput.model === undefined
                    ? undefined
                    : Schema.decodeUnknownSync(CakeModelSelection)(decodedInput.model),
                ),
              }
            : decodedInput;
          return control.invoke(
            {
              name: tool.command,
              arguments: argumentsValue,
              ...(tool.command === "sessions.set-model"
                ? { toolCallId: context.toolCallId }
                : null),
              ...(tool.command === "sessions.fork"
                ? { anchorPartId: `tool-${context.toolCallId}` }
                : null),
              ...(context.runtime.assistantEntryId &&
              (tool.command === "sessions.send" || tool.command === "sessions.reply")
                ? { sourceEntryId: context.runtime.assistantEntryId }
                : null),
            },
            context.signal,
          );
        },
      },
  );
  // Global/Durable Cake Chat uses the same separate batch tool, but each send
  // still crosses its existing trusted control and task-input boundary.
  if (control.tools.some((tool) => tool.command === "sessions.send"))
    operations.push(
      createSessionSendBatchOperation((input, signal, sourceEntryId) =>
        control.invoke({ name: "sessions.send", arguments: input, sourceEntryId }, signal),
      ),
    );
  return operations;
}
