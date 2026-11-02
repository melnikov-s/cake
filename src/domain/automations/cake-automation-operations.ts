import { Schema } from "effect";
import { compactDiscoveryGuidance } from "../../contracts/agent/discovery-result-text";
import {
  AutomationSessionInvocation,
  automationMemoryToolDescriptions,
  automationSessionToolDescriptions,
  automationToolDescriptions,
} from "../../contracts/automations/agent-automations";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from "../../contracts/serialization/json-contract";

export function createAutomationOperations(
  invoke: (command: string, input: JsonObject, signal: AbortSignal) => Promise<JsonValue>,
  automationSession = false,
  requiresAppControl = true,
): CakeOperationDefinition[] {
  const descriptions = automationSession
    ? [
        ...automationToolDescriptions,
        ...automationMemoryToolDescriptions,
        ...automationSessionToolDescriptions,
      ]
    : automationToolDescriptions;
  return descriptions.map((description) => {
    const schema = AutomationSessionInvocation.members.find((item) =>
      Schema.is(item.fields.name)(description.command),
    );
    if (!schema) throw new Error(`Missing automation control schema: ${description.command}`);
    return {
      command: description.command,
      topic: description.command.startsWith("memory.")
        ? "memory"
        : description.command.startsWith("projects.")
          ? "projects"
          : description.command === "sessions.create"
            ? "sessions"
            : "automations",
      requires: requiresAppControl ? "invokeAppControl" : undefined,
      summary: description.summary,
      guidance:
        description.command === "automations.create"
          ? [
              "Select explicit execution context and model settings. Never copy the creator's entire conversation or silently inherit its authority.",
              "An automation creates fresh Pi-backed Automation Sessions; project context is not Project Session identity or a worktree.",
            ]
          : ["automations.list", "automations.history"].includes(description.command)
            ? [compactDiscoveryGuidance]
            : [],
      result: description.result,
      inputSchema: schema.fields.arguments,
      examples: [],
      execute: (input, context) =>
        invoke(
          description.command,
          Schema.decodeUnknownSync(jsonObjectSchema)(input),
          context.signal,
        ),
    };
  });
}
