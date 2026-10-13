import {
  DefaultResourceLoader,
  createEventBus,
  type AgentSession,
  type EventBus,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { Option, Schema } from "effect";
import {
  CrossSessionContextSnapshot,
  CrossSessionQueueSnapshot,
} from "../../../contracts/conversations/cross-session-message";
import type { CakeOperationHost } from "../../../contracts/agent/cake-operation-context";
import type { JsonObject, JsonValue } from "../../../contracts/serialization/json-contract";
import { createMessageBoardExtension } from "./message-board-extension";
import { createSessionReferenceExtension } from "./session-reference-extension";
import { createCakeArtifactExtension } from "./artifact-extension";
import {
  CakeOperationRegistry,
  cakeToolDescription,
  cakeToolEnvelopeSchema,
} from "./cake-operation-registry";
import type { CakeOperationDefinition } from "../../../contracts/agent/cake-operation";
import type { RuntimeOperationApi } from "../../../contracts/agent/cake-operation-api";
import { loadCakeSessionRuntimeResourceLoader } from "./cake-session-runtime-resources";
import { detectGitWorktree, worktreeSystemPrompt } from "./worktree-system-prompt";
import { cakeAgentDocumentationDirectory } from "./cake-agent-documentation";
import { createCakeSystemPromptExtension } from "./cake-system-prompt-extension";
import projectPromptTemplate from "./prompts/project.md?raw";
import projectInvestigationPrompt from "./prompts/project-investigation.md?raw";
import { renderPromptTemplate } from "./prompt-template";
import { formatUnknown } from "./session-projection";
import { projectCakeOperationRuntime } from "./cake-operation-context";
import type { CakeSessionRuntimeOptions } from "./cake-session-runtime";

export function createCakeToolDefinition(
  definitions: readonly CakeOperationDefinition[],
  onRegistry?: (registry: CakeOperationRegistry) => void,
  projectResult?: (value: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
): ToolDefinition {
  const registry = new CakeOperationRegistry(definitions, projectResult);
  onRegistry?.(registry);
  return {
    name: "cake",
    label: "Cake",
    description: cakeToolDescription,
    promptSnippet: "Use Cake-native application controls.",
    // SAFETY: Pi accepts the draft-07 JSON Schema produced by Effect Schema.
    parameters: Schema.toStandardJSONSchemaV1(cakeToolEnvelopeSchema)["~standard"].jsonSchema.input(
      { target: "draft-07" },
    ) as TSchema,
    // SAFETY: Like parameters, this is the registry's Effect-derived draft-07 JSON Schema.
    outputSchema: Schema.toStandardJSONSchemaV1(registry.outputSchema())[
      "~standard"
    ].jsonSchema.output({ target: "draft-07" }) as TSchema,
    async execute(toolCallId, params, signal, onUpdate, runtime) {
      const update = (value: JsonValue) =>
        onUpdate?.({
          content: [{ type: "text", text: formatUnknown(value, 24_000) }],
          details: value,
        });
      const result = await registry.invoke(params, {
        signal: signal ?? new AbortController().signal,
        toolCallId,
        onUpdate: update,
        runtime: projectCakeOperationRuntime(runtime, toolCallId),
      });
      return {
        content: result.content,
        details: result.details,
        structuredContent: result.structuredContent,
      };
    },
  };
}

function createCakeGatewayExtension(
  definitions: (pi: CakeOperationHost) => CakeOperationDefinition[],
  onRegistry?: (registry: CakeOperationRegistry) => void,
  projectResult?: (value: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
): InlineExtension {
  return (pi) => {
    const host: CakeOperationHost = {
      appendEntry: (type, data) => pi.appendEntry(type, data),
      on: (event, handler) =>
        pi.on(event, (input) => handler({ systemPrompt: input.systemPrompt })),
    };
    pi.registerTool(createCakeToolDefinition(definitions(host), onRegistry, projectResult));
  };
}

function reviewContextExtension(
  pathForSession: (sessionId: string) => string,
  sessionId: () => string | undefined,
): InlineExtension {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const id = sessionId();
      if (!id) return;
      const path = pathForSession(id);
      if (!existsSync(path)) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\nInline code reviews and assistant-message discussions for this session are indexed at ${path}. Read or search that file when the user asks you to incorporate, summarize, or reason about those threads; otherwise leave it alone.`,
      };
    });
  };
}

interface RuntimeOperationApiReference {
  current?: RuntimeOperationApi;
}

interface RuntimeOperationRegistryReference {
  current?: CakeOperationRegistry;
}

interface RuntimeIdentity {
  sessionId?: string;
}

export interface CakeSessionRuntimeCapabilities {
  readonly resourceLoader: Awaited<ReturnType<typeof loadCakeSessionRuntimeResourceLoader>>;
  readonly eventBus: EventBus;
  readonly operationApi: RuntimeOperationApiReference;
  readonly operationRegistry: RuntimeOperationRegistryReference;
  setSessionId(sessionId: string): void;
  recordAppControlResult(result: JsonValue, session: AgentSession): Promise<JsonValue>;
  reportAgentAction(
    action: "compact" | "rename" | "resolve" | "restore" | "set-model",
    detail?: string,
  ): Promise<void>;
}

export async function createCakeSessionRuntimeCapabilities(input: {
  options: CakeSessionRuntimeOptions;
  publishSnapshot(): Promise<void>;
  agentDir: string;
  settingsManager: SettingsManager;
  modelRuntime: Pick<ModelRuntime, "getAvailableOfType">;
  /** Cake-owned in-process extensions that shape provider requests. */
  requestExtensions: readonly InlineExtension[];
}): Promise<CakeSessionRuntimeCapabilities> {
  const { options, agentDir, settingsManager, requestExtensions } = input;
  const persistArtifact =
    options.persistArtifact ??
    (async () => {
      throw new Error("Artifact persistence is unavailable in this runtime");
    });
  const compileArtifactBrowser =
    options.compileArtifactBrowser ??
    (async () => {
      throw new Error("Durable artifact browser compilation is unavailable in this runtime");
    });
  const operationApi: RuntimeOperationApiReference = {};
  const operationRegistry: RuntimeOperationRegistryReference = {};
  const captureOperationRegistry = (registry: CakeOperationRegistry) => {
    operationRegistry.current = registry;
  };
  const eventBus = createEventBus();
  const crossSessionReceiptSchema = Schema.Struct({
    ok: Schema.Literal(true),
    command: Schema.Literals(["sessions.send", "sessions.reply"]),
    targetTitle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    messageId: Schema.String.check(Schema.isUUID(4)),
    threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    messageNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    maxMessages: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    expectsResponse: Schema.Boolean,
    replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    recipientContext: Schema.optionalKey(CrossSessionContextSnapshot),
    queue: Schema.optionalKey(CrossSessionQueueSnapshot),
    status: Schema.Literals(["accepted", "queued", "delivered", "processing", "answered"]),
  });
  const reportAgentAction = async (
    action: "compact" | "rename" | "resolve" | "restore" | "set-model",
    detail?: string,
  ) => {
    const input: JsonObject = detail ? { action, detail } : { action };
    const signal = new AbortController().signal;
    try {
      if (options.currentSessionControl?.invokeAppControl)
        await options.currentSessionControl.invokeAppControl("agent.action", input, signal);
    } catch {
      // The completed agent action remains authoritative when its transient receipt cannot render.
    }
  };
  const runtimeIdentity: RuntimeIdentity = {};
  const cakeProjectSystemPrompt =
    options.isolatedSystemPrompt || options.auxiliaryProjectResources
      ? undefined
      : renderPromptTemplate(projectPromptTemplate, {
          cakeDocsDirectory: await cakeAgentDocumentationDirectory(agentDir),
        });
  const detectedWorktree = await detectGitWorktree(options.cwd);
  const detectedWorktreePrompt = detectedWorktree
    ? worktreeSystemPrompt(detectedWorktree)
    : undefined;
  const resourceLoader = await loadCakeSessionRuntimeResourceLoader({
    trusted: options.trusted,
    makeResourceLoader: () =>
      new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        eventBus,
        systemPrompt: options.isolatedSystemPrompt,
        appendSystemPromptOverride: (base) =>
          options.isolatedSystemPrompt
            ? []
            : [
                ...base,
                ...(options.auxiliaryProjectResources
                  ? []
                  : [`<cake_system_prompt>\n${cakeProjectSystemPrompt}\n</cake_system_prompt>`]),
                ...(options.additionalSystemPrompt
                  ? [
                      `<session_instructions>\n${options.additionalSystemPrompt}\n</session_instructions>`,
                    ]
                  : []),
                ...(detectedWorktreePrompt
                  ? [`<worktree_instructions>\n${detectedWorktreePrompt}\n</worktree_instructions>`]
                  : []),
                ...(options.projectInvestigation
                  ? [
                      `<project_investigation>\n${projectInvestigationPrompt}\n</project_investigation>`,
                    ]
                  : []),
              ],
        additionalSkillPaths: [],
        additionalPromptTemplatePaths: [],
        additionalExtensionPaths: [],
        noExtensions: options.auxiliary && !options.projectInvestigation,
        noSkills:
          options.auxiliary && !options.auxiliaryProjectResources && !options.projectInvestigation,
        noPromptTemplates: options.auxiliary && !options.projectInvestigation,
        noThemes: options.auxiliary && !options.projectInvestigation,
        noContextFiles: options.isolatedSystemPrompt !== undefined,
        extensionFactories:
          options.auxiliaryProjectResources || options.projectInvestigation
            ? [...requestExtensions]
            : [
                ...requestExtensions,
                createCakeSystemPromptExtension(),
                ...(options.sessionReferences
                  ? [createSessionReferenceExtension(options.sessionReferences)]
                  : []),
                createCakeGatewayExtension(
                  (pi) =>
                    options.operations?.({
                      host: pi,
                      publishSnapshot: input.publishSnapshot,
                      api: () => {
                        if (!operationApi.current) throw new Error("The Cake session is not ready");
                        return operationApi.current;
                      },
                      sessionId: () => runtimeIdentity.sessionId,
                      getAvailableOfType: async (type, filter, options) =>
                        (await input.modelRuntime.getAvailableOfType(type, filter, options)).map(
                          ({ provider, id }) => ({ provider, id }),
                        ),
                    }) ?? [],
                  captureOperationRegistry,
                  options.sessionReferences?.project,
                ),
                createCakeArtifactExtension({ persistArtifact, compileArtifactBrowser }),
                ...(options.messageBoardControl
                  ? [createMessageBoardExtension(options.messageBoardControl)]
                  : []),
                ...(options.reviewContextPath
                  ? [
                      reviewContextExtension(
                        options.reviewContextPath,
                        () => runtimeIdentity.sessionId,
                      ),
                    ]
                  : []),
              ],
      }),
  });
  return {
    resourceLoader,
    eventBus,
    operationApi,
    operationRegistry,
    setSessionId(sessionId) {
      runtimeIdentity.sessionId = sessionId;
    },
    async recordAppControlResult(result, session) {
      const receipt = Schema.decodeUnknownOption(crossSessionReceiptSchema)(result);
      if (Option.isSome(receipt)) {
        const count = receipt.value.messageNumber
          ? ` ${receipt.value.messageNumber}${receipt.value.maxMessages ? `/${receipt.value.maxMessages}` : ""}`
          : "";
        const context = receipt.value.recipientContext;
        const contextLabel = context
          ? ` · recipient context ${context.usedTokens === null ? "unknown" : `${Math.round(context.usedTokens / 1_000)}K`}/${context.windowTokens === null ? "unknown" : `${Math.round(context.windowTokens / 1_000)}K`}`
          : "";
        const queue = receipt.value.queue;
        const queueLabel = queue
          ? ` · ${queue.lane} position ${queue.position}/${queue.length}`
          : "";
        const queueHint = queue
          ? " Inspect or reorder with sessions.pending/sessions.reorder."
          : "";
        await session.sendCustomMessage(
          {
            customType: "Cross-session delivery",
            content: `${receipt.value.status === "queued" ? "Queued" : "Accepted"} message${count} for “${receipt.value.targetTitle}”${contextLabel}${queueLabel}. Informational receipt; no acknowledgment needed.${queueHint}`,
            display: true,
            details: result,
          },
          { triggerTurn: false },
        );
      }
      return result;
    },
    reportAgentAction,
  };
}
