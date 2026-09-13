import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import type { JsonObject, JsonValue } from "../../../ipc/json-contract";
import { jsonObjectSchema } from "../../../ipc/json-contract";
import type { UtilityModel } from "../../../ipc/session-contract";
import { createCakeToolDefinition, type GlobalControlTool } from "./cake-runtime-capabilities";
import { CakeOperationRegistry, type CakeOperationDefinition } from "./cake-operation-registry";
import { runIsolatedSession } from "./isolated-session-runner";
import { renderPromptTemplate } from "./prompt-template";
import sessionAssistantPromptTemplate from "./prompts/session-assistant.md?raw";
import { assertSessionPath } from "./session-path";

export interface SessionAssistantControlInvocation {
  readonly command: string;
  readonly input: JsonObject;
}

interface SessionAssistantOptions {
  readonly workspacePath: string;
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly sessionFile?: string;
  readonly parentSessionId: string;
  readonly utilityModel: UtilityModel;
  readonly prompt: string;
  readonly parentContextPrompt: string;
  readonly tools: readonly GlobalControlTool[];
  readonly signal?: AbortSignal;
  invoke(invocation: SessionAssistantControlInvocation, signal: AbortSignal): Promise<JsonValue>;
}

const ASSISTANT_OUTPUT_CHARACTERS = 100_000;
const ASSISTANT_TIMEOUT_MS = 90_000;

function controlOperations(
  tools: readonly GlobalControlTool[],
  invoke: SessionAssistantOptions["invoke"],
): CakeOperationDefinition[] {
  return tools.map((tool) => ({
    command: tool.command,
    topic: tool.topic,
    summary: tool.summary,
    guidance: tool.guidance,
    inputSchema: jsonObjectSchema,
    inputJsonSchema: tool.parameters,
    examples: tool.examples ?? [],
    result: tool.result ?? "A bounded result from Cake's authoritative application control.",
    limitations: tool.limitations,
    async execute(input, context) {
      const decoded = Schema.decodeUnknownSync(jsonObjectSchema)(input);
      return invoke({ command: tool.command, input: decoded }, context.signal);
    },
  }));
}

/** Runs one turn in the durable Discussion Session owned by a Project Session's avatar. */
export async function runSessionAssistant(options: SessionAssistantOptions) {
  if (options.sessionFile)
    assertSessionPath(options.sessionFile, options.sessionDirectory, "Session assistant file");
  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, options.sessionDirectory, options.workspacePath)
    : SessionManager.create(options.workspacePath, options.sessionDirectory);
  const operations = controlOperations(options.tools, options.invoke);
  const registry = new CakeOperationRegistry(operations);
  const systemPrompt = renderPromptTemplate(sessionAssistantPromptTemplate, {
    parentContextPrompt: options.parentContextPrompt,
    parentSessionId: options.parentSessionId,
    cakeProtocol: registry.completeHelp(),
  });
  const result = await runIsolatedSession({
    cwd: options.workspacePath,
    agentDir: options.agentDirectory,
    sessionManager,
    projectTrusted: true,
    tools: ["read", "cake"],
    customTools: [createCakeToolDefinition(operations)],
    systemPrompt,
    prompt: options.prompt,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(ASSISTANT_TIMEOUT_MS)])
      : AbortSignal.timeout(ASSISTANT_TIMEOUT_MS),
    model: {
      provider: options.utilityModel.provider,
      id: options.utilityModel.modelId,
    },
    thinkingLevel: options.utilityModel.thinkingLevel,
    modelPurpose: "utility",
    cancellationMessage: "Session assistant request was cancelled",
  });
  if (result.error) throw new Error(result.error);
  if (!result.sessionFile) throw new Error("The session assistant transcript was not persisted");
  return {
    sessionId: result.sessionId,
    sessionFile: result.sessionFile,
    response: result.response.trim().slice(0, ASSISTANT_OUTPUT_CHARACTERS) || "Done.",
  };
}
