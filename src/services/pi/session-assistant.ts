import { jsonObjectSchema } from "../../contracts/serialization/json-contract";
import type { GlobalControlTool } from "../../contracts/agent/cake-operation-control";
import { CakeOperationRegistry } from "./runtime/cake-operation-registry";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { renderPromptTemplate } from "./runtime/prompt-template";
import sessionAssistantPromptTemplate from "./runtime/prompts/session-assistant.md?raw";

/**
 * The session assistant's system prompt. It runs on the shared Discussion
 * Session sidecar runtime; only its instructions, model, and control gateway
 * differ from an ordinary side chat.
 */
export function sessionAssistantSystemPrompt(options: {
  readonly parentContextPrompt: string;
  readonly parentSessionId: string;
  readonly tools: readonly GlobalControlTool[];
}) {
  const operations: CakeOperationDefinition[] = options.tools.map((tool) => ({
    command: tool.command,
    topic: tool.topic,
    summary: tool.summary,
    guidance: tool.guidance,
    inputSchema: jsonObjectSchema,
    inputJsonSchema: tool.parameters,
    examples: tool.examples ?? [],
    result: tool.result ?? "A bounded result from Cake's authoritative application control.",
    limitations: tool.limitations,
    execute: async () => {
      throw new Error("Session assistant help operations are not executable");
    },
  }));
  return renderPromptTemplate(sessionAssistantPromptTemplate, {
    parentContextPrompt: options.parentContextPrompt,
    parentSessionId: options.parentSessionId,
    cakeProtocol: new CakeOperationRegistry(operations).completeHelp(),
  });
}
