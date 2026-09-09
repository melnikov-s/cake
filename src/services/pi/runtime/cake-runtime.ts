import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent,
  type InlineExtension,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { RuntimeTurnCompletion } from "./RuntimeTurnCompletion";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Option, Schema } from "effect";
import type {
  Attachment,
  ChatConfiguration,
  PiSettings,
  PiSettingUpdate,
  ExtensionUiEvent,
  ExtensionUiIntent,
  ResourceDiagnostic,
  SessionSnapshot,
  SessionUsage,
  ThinkingLevel,
  ToolOutputContent,
  UiPart,
  UtilityModel,
} from "../../../ipc/session-contract";
import {
  SESSION_TITLE_MAX_LENGTH,
  parsePiBuiltinCommand,
  piBuiltinSlashCommands,
  slashCommandSchema,
} from "../../../ipc/session-contract";
import {
  CakeModelSelection,
  resolveCakeModelSelection,
  type CakeModelPresetCatalog,
  type ExplicitCakeModelSelection,
} from "../../../domain/cake-model-selection";
import type {
  ParallelSubagentInput as DomainParallelSubagentInput,
  SubagentTaskInput as DomainSubagentTaskInput,
} from "../../../domain/subagent-data";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../../ipc/json-contract";
import {
  artifactRecordSchema,
  type ArtifactRecord,
  type ArtifactPointer,
  type CakeArtifactV1,
} from "../../../ipc/artifact-contract";
import type { TSchema } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  applyFastModePayload,
  FastModePayload,
  supportsFastMode,
  type FastModeModel,
} from "../fast-mode";
import { compatibilityCatalog } from "../live/PiCompatibilityProjection";
import { projectModelCatalog } from "../live/PiModelsLive";
import { createCakeArtifactExtension } from "./artifact-extension";
import { createCakeArtifactOperations } from "./cake-artifact-operations";
import { createCakeModelOperations } from "./cake-model-operations";
import { createCakeVscodeOperations, type VscodeControl } from "./cake-vscode-operations";
import {
  createCakeWorktreeOperations,
  type WorktreeLandingControl,
} from "./cake-worktree-operations";
import {
  CakeOperationRegistry,
  cakeToolDescription,
  cakeToolEnvelopeSchema,
  type CakeOperationDefinition,
} from "./cake-operation-registry";
import {
  INTERRUPTED_TURN_NOTICE_PART_ID,
  TURN_RECOVERY_MAX_AUTO_CONTINUATIONS,
  TURN_RECOVERY_NOTICE_PART_ID,
  classifyTurnFailure,
  interruptedTurnResumePrompt,
  shouldAutoResumeInterruptedTurn,
  turnRecoveryPrompt,
} from "./turn-recovery";
import { createCakeExtensionUiContext } from "./extension-compatibility";
import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
  ReviewParentContext,
} from "./sidecar-runtime";
import { assertSessionPath } from "./session-path";
import { ResponseRetryController, type ResponseRetryNotice } from "./response-retry";
import { ReloadableResourceLoader } from "./ReloadableResourceLoader";
import { applyPiSetting } from "./settings-translation";
import { cakeWorkspaceSessionDirectory, findSessionFile } from "./session-discovery";
import { createConversationHandoff } from "./session-handoff";
import { detectGitWorktree, worktreeSystemPrompt } from "./worktree-system-prompt";
import cakeChatPromptTemplate from "./prompts/cake-chat.md?raw";
import commonPromptTemplate from "./prompts/common.md?raw";
import interviewPromptTemplate from "./prompts/interview.md?raw";
import projectInteractionPromptTemplate from "./prompts/project-interaction.md?raw";
import projectPromptTemplate from "./prompts/project.md?raw";
import { renderPromptTemplate } from "./prompt-template";
import {
  parallelSubagentSchema,
  subagentTaskSchema,
  type SubagentTaskInput,
} from "./subagent-contract";
import {
  boundedProjectionKey,
  cakeOperationCommand,
  createLiveMessageProjector,
  formatToolInput,
  formatToolResult,
  formatUnknown,
  imageContent,
  projectArtifactPointers,
  projectQueuedMessages,
  projectSessionEntries,
  projectTree,
  promptText,
  reviewRunEntrySchema,
  reviewRunEntryType,
  reviewRunPart,
  shellCommandPart,
  textFromContent,
  userMessagePresentationEntrySchema,
  userMessagePresentationEntryType,
  toolArtifactId,
  toolFilePath,
  toolResultOutputContent,
  toolResultDiff,
  type ReviewRunEntry,
} from "./session-projection";

export const piRuntimeVersion = "0.84.0" as const;
const commonPrompt = renderPromptTemplate(commonPromptTemplate);
const interviewPrompt = renderPromptTemplate(interviewPromptTemplate);
const projectInteractionPrompt = renderPromptTemplate(projectInteractionPromptTemplate, {
  interviewPrompt,
});
const cakeChatSystemPrompt = renderPromptTemplate(cakeChatPromptTemplate, {
  commonPrompt,
  interviewPrompt,
});
const cakeProjectSystemPrompt = renderPromptTemplate(projectPromptTemplate, {
  commonPrompt,
  projectInteractionPrompt,
});

export const projectSessionCreateInputSchema = Schema.Struct({
  name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  initialPrompt: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
  model: Schema.optionalKey(CakeModelSelection),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
});
type ProjectSessionCreateInput = typeof projectSessionCreateInputSchema.Type;

export interface RuntimeUiRequest {
  kind: "confirm" | "text" | "secret" | "select" | "manual_code" | "editor";
  title: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  options?: Array<{ id: string; label: string }>;
  signal?: AbortSignal;
  timeout?: number;
}

export type CakeRuntimeEvent =
  | { type: "snapshot"; requestId?: string; snapshot: SessionSnapshot }
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming"; sessionId: string; streaming: boolean }
  | { type: "usage-updated"; sessionId: string; usage: SessionUsage }
  | { type: "extension-ui"; sessionId: string; event: ExtensionUiEvent };

export interface CakeRuntimeOptions {
  cwd: string;
  trusted: boolean;
  agentDir: string;
  sessionDir: string;
  resolvedSessionDir?: string;
  newSession?: boolean;
  sessionId?: string;
  sessionFile?: string;
  additionalSystemPrompt?: string;
  tools?: string[];
  auxiliary?: boolean;
  /** Subset of builtin slash command names to advertise; defaults to all of them. */
  slashCommands?: readonly string[];
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  emitExtensionUiIntent?(intent: ExtensionUiIntent): void;
  persistArtifact?(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact?(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
  listArtifacts?(pointers: ArtifactPointer[]): Promise<ArtifactRecord[]>;
  openExternal?(url: string): Promise<void>;
  reviewContextPath?(sessionId: string): string;
  utilityModel?(): UtilityModel | undefined;
  modelPresets?(): CakeModelPresetCatalog;
  fastMode?: {
    get(): boolean;
    set(enabled: boolean): Promise<void>;
  };
  generateSessionTitle?(input: {
    utilityModel: UtilityModel;
    firstUserMessage: string;
    signal?: AbortSignal;
  }): Promise<string>;
  sessionMetadata?: {
    setTitle(sessionId: string, title: string): Promise<void>;
  };
  currentSessionControl?: {
    resolved(): boolean;
    canResolve?(): boolean;
    familyInfo?(): JsonValue;
    deferResolution?: boolean;
    setResolved(resolved: boolean): Promise<void>;
    createSession?(
      input: {
        name: string;
        initialPrompt: string;
        model: ChatConfiguration;
        worktreeName?: string;
      },
      signal: AbortSignal,
    ): Promise<JsonValue>;
    createDraftSession?(
      input: { name: string; initialPrompt: string; model?: ChatConfiguration },
      signal: AbortSignal,
    ): Promise<JsonValue>;
    createChildSession?(
      input: {
        requestId: string;
        title: string;
        initialPrompt: string;
        model: ChatConfiguration;
        placement: "none" | "right" | "down";
      },
      signal: AbortSignal,
    ): Promise<JsonValue>;
    routeFamilyMessage?(input: JsonObject, signal: AbortSignal): Promise<JsonValue | undefined>;
    invokeAppControl?(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
  };
  vscodeControl?: VscodeControl;
  worktreeLandingControl?: WorktreeLandingControl;
  globalControl?: {
    tools: readonly GlobalControlTool[];
    invoke(input: { name: string; arguments: JsonValue }, signal: AbortSignal): Promise<JsonValue>;
  };
  agentControl?: {
    run(
      input: DomainSubagentTaskInput,
      parentSessionId: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
      anchorPartId?: string,
    ): Promise<JsonValue>;
    start(
      input: DomainSubagentTaskInput,
      parentSessionId: string,
      signal: AbortSignal,
      anchorPartId?: string,
    ): Promise<JsonValue>;
    parallel(
      input: DomainParallelSubagentInput,
      parentSessionId: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
      anchorPartId?: string,
    ): Promise<JsonValue>;
    prompt(
      input: { handleId: string; text: string; delivery: "prompt" | "follow-up" },
      parentSessionId: string,
      signal: AbortSignal,
    ): Promise<JsonValue>;
    wait(
      handleId: string,
      parentSessionId: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
    ): Promise<JsonValue>;
    abort(handleId: string, parentSessionId: string): Promise<JsonValue>;
    close(handleId: string, parentSessionId: string): Promise<JsonValue>;
  };
  onEvent(event: CakeRuntimeEvent): void;
}

interface GlobalControlTool {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  parameters: JsonObject;
  examples?: readonly { input?: JsonObject; description?: string }[];
  result?: string;
  limitations?: readonly string[];
}

/** Pi throws this when a plain prompt arrives while the agent turn is streaming. */
function isAlreadyProcessingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Agent is already processing. Specify streamingBehavior")
  );
}

function retryNotice(event: ResponseRetryNotice): Extract<UiPart, { kind: "notice" }> {
  return {
    id: "active-retry",
    kind: "notice",
    tone: "warning",
    title: `Retry ${event.attempt}/${event.maxAttempts}`,
    detail: event.errorMessage,
    retryAt: Date.now() + event.delayMs,
  };
}

function createFastModeExtension(isEnabled: () => boolean): InlineExtension {
  return (pi) => {
    pi.on("before_provider_request", (event, context) => {
      const payload = Schema.decodeUnknownOption(FastModePayload)(event.payload);
      return Option.isSome(payload)
        ? applyFastModePayload(payload.value, context.model, isEnabled())
        : event.payload;
    });
  };
}

export function createGlobalControlOperations(
  control: NonNullable<CakeRuntimeOptions["globalControl"]>,
  resolveModel: (selection: CakeModelSelection | undefined) => ExplicitCakeModelSelection,
): CakeOperationDefinition[] {
  return control.tools.map((tool) => ({
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
      const result = await control.invoke(
        { name: tool.command, arguments: argumentsValue },
        context.signal,
      );
      const object = Schema.decodeUnknownOption(jsonObjectSchema)(result);
      if (Option.isNone(object)) return result;
      const semanticResult = Object.fromEntries(
        Object.entries(object.value).filter(([key]) => key !== "name"),
      );
      return { ...semanticResult, command: tool.command };
    },
  }));
}

export function createAgentControlOperations(
  control: NonNullable<CakeRuntimeOptions["agentControl"]>,
  parentSessionId: () => string | undefined,
  resolveModel: (selection: CakeModelSelection | undefined) => ExplicitCakeModelSelection,
): CakeOperationDefinition[] {
  const promptSchema = Schema.Struct({
    handleId: Schema.String.check(Schema.isUUID()),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  });
  const handleSchema = Schema.Struct({ handleId: Schema.String.check(Schema.isUUID()) });
  const guidance = [
    "Subagents are private, hidden, bounded workers—not full Project Sessions. A request for a child session, related session, or Session Family member is not subagent delegation; use sessions.create-child instead.",
    "Use subagents only when the user explicitly requested delegation, subagents, or parallel agent work.",
    "Use subagents.run for ordinary single-task delegation so the result returns in the same tool call. Use subagents.start only for explicitly background work; Cake automatically delivers its completion, so do not poll it.",
    "subagents.wait is an optional synchronization barrier for background work, not a required completion mechanism.",
    "Handles are parent-owned. Delegation depth defaults to zero and is capped at one; parallel batches contain at most eight tasks.",
    "When model is omitted, a subagent inherits the calling session's current model, thinking level, and Fast mode setting.",
  ];
  const resolveTask = (input: SubagentTaskInput): DomainSubagentTaskInput => {
    const model = resolveModel(input.model);
    return {
      ...input,
      model: {
        prefer: "exact",
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel,
      },
      fastMode: model.fastMode,
    };
  };
  const operation = <Input>(definition: {
    command: string;
    summary: string;
    schema: Schema.ConstraintDecoder<Input, never>;
    example: JsonObject;
    run(
      input: Input,
      parent: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
      anchorPartId?: string,
    ): Promise<JsonValue>;
  }): CakeOperationDefinition => ({
    command: definition.command,
    topic: "subagents",
    summary: definition.summary,
    guidance,
    inputSchema: definition.schema,
    examples: [{ input: definition.example }],
    result:
      "A bounded handle, activity projection, or final delegated result with attributed usage.",
    limitations: [
      "Recursive delegation is unavailable unless this runtime was explicitly granted remaining depth.",
    ],
    async execute(input, context) {
      const parent = parentSessionId();
      if (!parent) throw new Error("The parent Cake session is not ready");
      // SAFETY: CakeOperationRegistry parsed input with this definition's schema.
      return definition.run(
        input as Input,
        parent,
        context.signal,
        context.onUpdate,
        `tool-${context.toolCallId}`,
      );
    },
  });
  return [
    operation({
      command: "subagents.run",
      summary:
        "Run one isolated parent-owned subagent in the foreground, stream its activity, and return its final result.",
      schema: subagentTaskSchema,
      example: {
        task: "Inspect the authentication flow",
        profile: "scout",
        model: "Sol",
        maxDepth: 0,
        retain: false,
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.run(resolveTask(input), parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.start",
      summary:
        "Explicitly start one isolated parent-owned subagent in the background. Cake automatically wakes the parent with its result unless the parent is already waiting on it.",
      schema: subagentTaskSchema,
      example: {
        task: "Monitor the test run",
        profile: "worker",
        model: "Sol",
        maxDepth: 0,
        retain: false,
      },
      run: (input, parent, signal, _onUpdate, anchor) =>
        control.start(resolveTask(input), parent, signal, anchor),
    }),
    operation({
      command: "subagents.parallel",
      summary: "Run up to eight bounded subagent tasks with workspace-wide bounded concurrency.",
      schema: parallelSubagentSchema,
      example: {
        tasks: [
          {
            task: "Inspect tests",
            profile: "scout",
            model: "Sol",
            maxDepth: 0,
            retain: false,
          },
        ],
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.parallel({ tasks: input.tasks.map(resolveTask) }, parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.prompt",
      summary: "Send a normal prompt to an idle retained subagent and wait for its turn.",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Continue" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "prompt" }, parent, signal),
    }),
    operation({
      command: "subagents.follow-up",
      summary: "Queue a follow-up using Pi's normal queue policy.",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Also inspect callers" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "follow-up" }, parent, signal),
    }),
    operation({
      command: "subagents.wait",
      summary:
        "Optionally wait for an explicitly backgrounded subagent. While this wait is active, its result returns through this call instead of triggering a separate parent turn.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent, signal, onUpdate) =>
        control.wait(input.handleId, parent, signal, onUpdate),
    }),
    operation({
      command: "subagents.abort",
      summary: "Cancel active work in a subagent.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.abort(input.handleId, parent),
    }),
    operation({
      command: "subagents.close",
      summary: "Release a subagent handle and its hidden runtime.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.close(input.handleId, parent),
    }),
  ];
}

function createCakeGatewayExtension(
  definitions: (pi: {
    appendEntry(type: string, data: JsonValue): void;
  }) => CakeOperationDefinition[],
): InlineExtension {
  return (pi) => {
    const registry = new CakeOperationRegistry(definitions(pi));
    pi.registerTool({
      name: "cake",
      label: "Cake",
      description: cakeToolDescription,
      // SAFETY: Pi accepts the draft-07 JSON Schema produced by Effect Schema.
      parameters: Schema.toStandardJSONSchemaV1(cakeToolEnvelopeSchema)[
        "~standard"
      ].jsonSchema.input({ target: "draft-07" }) as TSchema,
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
          runtime,
        });
        return { content: [{ type: "text", text: result.text }], details: result.details };
      },
    });
  };
}

function reviewContextExtension(
  pathForSession: (sessionId: string) => string,
  sessionId: () => string | undefined,
): InlineExtension {
  return (pi) => {
    pi.on("before_agent_start", () => {
      const id = sessionId();
      if (!id) return;
      const path = pathForSession(id);
      if (!existsSync(path)) return;
      return {
        message: {
          customType: "cake.review-context",
          display: false,
          content: `Inline code reviews and assistant-message discussions for this session are indexed at ${path}. Read or search that file when the user asks you to incorporate, summarize, or reason about those threads; otherwise leave it alone.`,
        },
      };
    });
  };
}

export interface CakeRuntime {
  readonly sessionId: string;
  readonly sessionFile: string;
  /** Returns Pi's live turn state without assembling a SessionSnapshot. */
  readonly streaming: boolean;
  executingTurnIds?(): ReadonlyArray<string>;
  getReviewParentContext?(): ReviewParentContext;
  recordReviewRun(run: ReviewRunEntry): void;
  snapshot(): Promise<SessionSnapshot>;
  notifySubagentCompletion?(result: JsonValue): Promise<void>;
  prompt(
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown?: boolean,
    turnId?: string,
  ): Promise<void>;
  listQueuedMessages(): Promise<{ steering: string[]; followUp: string[] }>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  editMessage?(
    entryId: string,
    text: string,
    attachments: Attachment[],
    renderUserMessageAsMarkdown: boolean,
  ): Promise<void>;
  setUserMessageMarkdown(entryId: string, renderAsMarkdown: boolean): Promise<void>;
  compact(instructions?: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /** Applies a full chat configuration atomically, emitting a single snapshot. */
  applyConfiguration(configuration: ChatConfiguration): Promise<void>;
  setFastMode?(enabled: boolean): Promise<void>;
  syncFastMode?(): Promise<void>;
  setPiSetting(update: PiSettingUpdate): Promise<void>;
  reload?(): Promise<void>;
  refreshModels?(): Promise<void>;
  login(provider: string, authType: "api_key" | "oauth"): Promise<void>;
  logout(provider: string): Promise<void>;
  rename(name: string): Promise<void>;
  fork(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  handoff(
    entryId: string,
    destination?: { readonly workingDirectory: string; readonly sessionRoot: string },
  ): Promise<{ sessionId: string; sessionFile: string }>;
  navigate(entryId: string): Promise<void>;
  dispose(): void | Promise<void>;
}

export async function createCakeRuntime(options: CakeRuntimeOptions): Promise<CakeRuntime> {
  const agentDir = options.agentDir;
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.trusted,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`,
  });
  const persistArtifact =
    options.persistArtifact ??
    (async (artifact: CakeArtifactV1) =>
      Schema.decodeUnknownSync(artifactRecordSchema)({
        artifact,
        workspacePath: options.cwd,
        digest: "0".repeat(64),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
  const requestArtifact = options.requestArtifact ?? (async () => undefined);
  interface RuntimeOperationApi {
    info(): JsonValue;
    usage(): JsonValue;
    contextStatus(): JsonValue;
    compact(instructions?: string): Promise<JsonValue>;
    rename(title: string): Promise<JsonValue>;
    createSession(input: ProjectSessionCreateInput, signal: AbortSignal): Promise<JsonValue>;
    createDraftSession(
      input: { name: string; initialPrompt: string; model?: CakeModelSelection },
      signal: AbortSignal,
    ): Promise<JsonValue>;
    createChildSession(
      input: {
        title: string;
        initialPrompt: string;
        model?: CakeModelSelection;
        placement: "none" | "right" | "down";
      },
      requestId: string,
      signal: AbortSignal,
    ): Promise<JsonValue>;
    invokeAppControl(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
    resolveModelSelection(selection: CakeModelSelection | undefined): ExplicitCakeModelSelection;
    setModel(model: CakeModelSelection): Promise<JsonValue>;
    setResolved(resolved: boolean): Promise<JsonValue>;
  }
  interface RuntimeOperationApiReference {
    current?: RuntimeOperationApi;
  }
  const crossSessionReceiptSchema = Schema.Struct({
    ok: Schema.Literal(true),
    name: Schema.Literals(["send_session_message", "reply_session_message"]),
    targetTitle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    messageId: Schema.String.check(Schema.isUUID(4)),
    threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    messageNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    maxMessages: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    status: Schema.Literals(["accepted", "queued", "delivered", "processing", "answered"]),
  });
  const operationApi: RuntimeOperationApiReference = {};
  const reportAgentAction = async (
    action: "compact" | "rename" | "resolve" | "restore" | "set-model",
    detail?: string,
  ) => {
    const input: JsonObject = detail ? { action, detail } : { action };
    const signal = new AbortController().signal;
    try {
      if (options.currentSessionControl?.invokeAppControl)
        await options.currentSessionControl.invokeAppControl("agent.action", input, signal);
      else if (options.globalControl)
        await options.globalControl.invoke({ name: "agent.action", arguments: input }, signal);
    } catch {
      // The completed agent action remains authoritative when its transient receipt cannot render.
    }
  };
  const localOperations = (): CakeOperationDefinition[] => {
    const api = () => {
      if (!operationApi.current) throw new Error("The Cake session is not ready");
      return operationApi.current;
    };
    const empty = Schema.Struct({});
    const invokeAppControl =
      (command: string): CakeOperationDefinition["execute"] =>
      (input, context) => {
        // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
        return api().invokeAppControl(command, input as JsonObject, context.signal);
      };
    const operations: CakeOperationDefinition[] = [
      {
        command: "app.state",
        topic: "app",
        summary: "Inspect the invoking Cake window's current selection and session summaries.",
        inputSchema: empty,
        examples: [{}],
        result: "The current application selection, projects, and bounded session summaries.",
        execute: (_input, context) => api().invokeAppControl("app.state", {}, context.signal),
      },
      {
        command: "app.split",
        topic: "app",
        summary: "Split the calling conversation pane and open a new chat in it.",
        guidance: ["Splits are relative to the calling conversation's pane."],
        inputSchema: Schema.Struct({ direction: Schema.Literals(["right", "down"]) }),
        examples: [{ input: { direction: "right" } }],
        result: "The new pane and conversation identity.",
        execute: invokeAppControl("app.split"),
      },
      {
        command: "session.info",
        topic: "sessions",
        summary:
          "Return minimal identity, workspace, resolution, and model information for the calling session.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
        ],
        inputSchema: empty,
        examples: [{}],
        result: "sessionId, title, workspacePath, resolved, and provider/model/reasoning only.",
        execute: async () => api().info(),
      },
      {
        command: "session.rename",
        topic: "sessions",
        summary: "Rename the calling session.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
        ],
        inputSchema: Schema.Struct({
          title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        }),
        examples: [{ input: { title: "Authentication refactor" } }],
        result: "The calling session ID and committed title.",
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().rename((input as { title: string }).title);
        },
      },
      {
        command: "session.create",
        topic: "sessions",
        summary:
          "Create, name, and start an independent Project Session in the calling session's project.",
        guidance: [
          "This singular Project Session-local operation derives the project from the caller and never accepts a workspacePath or sessionId. Cake Chat uses the separate plural sessions.create application control.",
          "Set worktreeName to create and register a new Cake-managed worktree before the Pi-backed session starts. Do not run git worktree add or try to rebind an already-started session.",
          "When worktreeName is omitted, the independent session starts in the Project root, preserving the existing behavior.",
          "When model is omitted, the new session inherits the calling session's current model, thinking level, and Fast mode setting.",
          "Use sessions.create-child only for a Session Family child that shares the caller's exact Working Directory.",
        ],
        inputSchema: projectSessionCreateInputSchema,
        examples: [
          {
            input: {
              name: "Authentication follow-up",
              initialPrompt: "Review the authentication flow and implement the next changes.",
              model: "Sol",
            },
            description: "Select a configured preset and start in the Project root.",
          },
          {
            input: {
              name: "Investigate rendering",
              initialPrompt: "Investigate the rendering issue and implement a focused fix.",
              worktreeName: "investigate-rendering",
            },
            description: "Start an independent session in a new Cake-managed worktree.",
          },
        ],
        result:
          "The started session ID, actual Working Directory, and managed-worktree record when one was requested.",
        limitations: [
          "This creates an independent Project Session, not a Session Family child.",
          "An active Project Session cannot be relocated to the newly created worktree.",
        ],
        execute: (input, context) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().createSession(input as ProjectSessionCreateInput, context.signal);
        },
      },
      {
        command: "sessions.create-child",
        topic: "sessions",
        summary: "Create and start a full child Project Session in the calling session's family.",
        guidance: [
          "Use this operation—not cake subagents—when the user asks for a child session, full child Project Session, related session, or Session Family member.",
          "Call it with input containing the required title and initialPrompt fields; the assignment field is initialPrompt, not prompt.",
          "The calling session becomes the family parent when it creates its first child.",
          "Children inherit the exact Project and Working Directory, share mutable files, and start in the background.",
          "This operation returns after the initial child turn is accepted; do not wait or poll for the child, and finish the parent turn normally.",
          "Pane placement defaults to none. Set placement to right or down only when the child should be opened beside the parent.",
          "A child cannot create another child; it must ask its parent for further delegation.",
          "When model is omitted, the child inherits the calling session's current model, thinking level, and Fast mode setting.",
        ],
        inputSchema: Schema.Struct({
          title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
          initialPrompt: Schema.Trim.pipe(
            Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
          ),
          model: Schema.optionalKey(CakeModelSelection),
          placement: Schema.Literals(["none", "right", "down"]).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("none" as const)),
          ),
        }),
        examples: [
          {
            input: {
              title: "Storage implementation",
              initialPrompt: "Implement the storage slice and message me when it is ready.",
              model: "Sol",
              placement: "right",
            },
            description: "Select a configured preset by name.",
          },
        ],
        result: "The stable child session identity and initial-turn launch outcome.",
        limitations: [
          "V1 families have one level and fixed Working Directory bindings.",
          "This operation does not create or select a different worktree.",
        ],
        execute: (input, context) =>
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          api().createChildSession(
            input as {
              title: string;
              initialPrompt: string;
              model?: CakeModelSelection;
              placement: "none" | "right" | "down";
            },
            context.toolCallId,
            context.signal,
          ),
      },
      {
        command: "session.create-draft",
        topic: "sessions",
        summary:
          "Create a saved draft in the calling Project Session's project without starting a Pi session.",
        guidance: [
          "This operation derives the project from the calling session and never accepts a workspacePath or sessionId.",
          "When model is omitted, the draft snapshots the calling session's current model, thinking level, and Fast mode setting.",
        ],
        inputSchema: Schema.Struct({
          name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
          initialPrompt: Schema.Trim.pipe(
            Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
          ),
          model: Schema.optionalKey(CakeModelSelection),
        }),
        examples: [
          {
            input: {
              name: "Authentication follow-up",
              initialPrompt: "Review the authentication flow and propose the next changes.",
              model: "Sol",
            },
            description: "Select a configured preset by name.",
          },
        ],
        result: "The saved draft session ID and confirmation that renderer persistence completed.",
        execute: (input, context) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().createDraftSession(
            input as { name: string; initialPrompt: string; model?: CakeModelSelection },
            context.signal,
          );
        },
      },
      {
        command: "sessions.list",
        topic: "sessions",
        summary: "List Project Sessions across all registered Cake projects.",
        inputSchema: empty,
        examples: [{}],
        result:
          "Project Session identities, projects, paths, titles, activity, and resolution state.",
        execute: (_input, context) => api().invokeAppControl("sessions.list", {}, context.signal),
      },
      {
        command: "sessions.send",
        topic: "sessions",
        summary: "Send a message to an explicitly targeted Project Session in any Cake project.",
        guidance: [
          "Set delivery to steer to interrupt and redirect a running target. Omit delivery for normal behavior: start an idle target or queue behind an active target.",
        ],
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
          delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
          maxMessages: Schema.optionalKey(
            Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
          ),
        }),
        examples: [{ input: { sessionId: "target-session-id", text: "Review the API changes." } }],
        result:
          "A visible correlated receipt with target label, thread and message IDs, count, delivery state, and accepted delivery mode.",
        execute: invokeAppControl("sessions.send"),
      },
      {
        command: "sessions.abort",
        topic: "sessions",
        summary: "Stop the active turn in an explicitly targeted Project Session.",
        guidance: [
          "Use this to stop a running child or other Project Session without resolving or deleting it; the session remains available for later messages.",
        ],
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        }),
        examples: [{ input: { sessionId: "target-session-id" } }],
        result: "A confirmed stopping status, or an error when the target is not running.",
        execute: invokeAppControl("sessions.abort"),
      },
      {
        command: "sessions.reply",
        topic: "sessions",
        summary:
          "Reply to the originating session in the current open exchange without carrying its session ID.",
        inputSchema: Schema.Struct({
          text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
          delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        }),
        examples: [{ input: { text: "I agree; here is one caveat." } }],
        result: "A correlated delivery receipt for the safely bound reply target.",
        execute: invokeAppControl("sessions.reply"),
      },
      {
        command: "sessions.thread",
        topic: "sessions",
        summary: "Inspect participants, message count, limit, closure, and delivery states.",
        inputSchema: Schema.Struct({
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        }),
        examples: [{ input: {} }],
        result: "The current Cake coordination thread projection.",
        execute: invokeAppControl("sessions.thread"),
      },
      {
        command: "sessions.close-thread",
        topic: "sessions",
        summary:
          "Close the current exchange so queued or late arrivals cannot cause an automatic reply.",
        inputSchema: Schema.Struct({
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        }),
        examples: [{ input: {} }],
        result: "A closed thread receipt and final message count.",
        execute: invokeAppControl("sessions.close-thread"),
      },
      {
        command: "sessions.compact",
        topic: "sessions",
        summary: "Compact an explicitly targeted Project Session.",
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
        }),
        examples: [{ input: { sessionId: "target-session-id" } }],
        result: "A completed compaction status.",
        execute: invokeAppControl("sessions.compact"),
      },
      {
        command: "sessions.schedule",
        topic: "sessions",
        summary:
          "Schedule a message to an explicitly targeted Project Session at an ISO timestamp.",
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
          sendAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        }),
        examples: [
          {
            input: {
              sessionId: "target-session-id",
              text: "Check the build result.",
              sendAt: "2030-01-01T12:00:00.000Z",
            },
          },
        ],
        result: "The durable scheduled message and its ID.",
        execute: invokeAppControl("sessions.schedule"),
      },
      {
        command: "sessions.scheduled",
        topic: "sessions",
        summary: "List durable scheduled messages, optionally for one Project Session.",
        inputSchema: Schema.Struct({
          sessionId: Schema.optionalKey(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          ),
        }),
        examples: [{}],
        result: "Scheduled message IDs, destinations, text, and send times.",
        execute: invokeAppControl("sessions.scheduled"),
      },
      {
        command: "sessions.cancel-scheduled",
        topic: "sessions",
        summary: "Cancel one scheduled message by ID.",
        inputSchema: Schema.Struct({
          id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        }),
        examples: [{ input: { id: "scheduled-message-id" } }],
        result: "A cancellation status.",
        execute: invokeAppControl("sessions.cancel-scheduled"),
      },
      {
        command: "session.resolve",
        topic: "sessions",
        summary: "Idempotently resolve or restore the calling session.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
          "Resolving during an active response is scheduled for the moment that response settles.",
        ],
        inputSchema: Schema.Struct({ resolved: Schema.Boolean }),
        examples: [{ input: { resolved: true } }],
        result:
          "The calling session ID and either the committed resolved value or a resolveOnSettle marker.",
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().setResolved((input as { resolved: boolean }).resolved);
        },
      },
      {
        command: "session.usage",
        topic: "sessions",
        summary:
          "Return normalized provider-reported token usage and cost for the calling session.",
        guidance: ["Usage is advisory and is not a hard spending-limit mechanism."],
        inputSchema: empty,
        examples: [{}],
        result: "Normalized token counts, reported cost in USD, and honest pricing coverage.",
        execute: async () => api().usage(),
      },
      {
        command: "session.set-model",
        topic: "sessions",
        summary:
          "Set the calling session's model from a configured preset or explicit configuration.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
        ],
        inputSchema: Schema.Struct({ model: CakeModelSelection }),
        examples: [
          {
            input: { model: "Sol" },
            description: "Select a configured preset by name.",
          },
        ],
        result: "The committed provider, model ID, thinking level, and Fast mode setting.",
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().setModel((input as { model: CakeModelSelection }).model);
        },
      },
      {
        command: "context.status",
        topic: "context",
        summary: "Inspect estimated current context use through Pi's public usage facilities.",
        inputSchema: empty,
        examples: [{}],
        result: "tokens, limit, remaining, utilization, and measurement only.",
        execute: async () => api().contextStatus(),
      },
      {
        command: "context.compact",
        topic: "context",
        summary: "Invoke Pi's normal compaction mechanism for the calling session.",
        inputSchema: Schema.Struct({
          instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
        }),
        examples: [
          {
            input: { instructions: "Preserve implementation decisions and pending verification." },
          },
        ],
        result: "A completed compaction status.",
        limitations: ["Cake does not create a separate summary or transcript representation."],
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().compact((input as { instructions?: string }).instructions);
        },
      },
      {
        command: "notifications.send",
        topic: "notifications",
        summary: "Send a bounded native system notification through the operating system.",
        inputSchema: Schema.Struct({
          title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
          level: Schema.Literals(["info", "success", "warning", "error"]).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("info" as const)),
          ),
        }),
        examples: [
          {
            input: {
              title: "Authentication refactor complete",
              body: "The implementation and focused tests are ready for review.",
              level: "success",
            },
          },
        ],
        result: "A queued status after Cake accepts the notification for debounced delivery.",
        limitations: [
          "Notifications are debounced per calling session, so only the latest message in a burst is delivered.",
          "Notifications do not impersonate user input or enter another session transcript.",
        ],
        execute: invokeAppControl("notifications.send"),
      },
    ];
    return operations.filter(
      (operation) =>
        (operation.command !== "session.resolve" ||
          (options.currentSessionControl !== undefined &&
            options.currentSessionControl.canResolve?.() !== false)) &&
        (!["app.state", "app.split", "notifications.send"].includes(operation.command) ||
          options.currentSessionControl?.invokeAppControl !== undefined) &&
        (operation.command !== "session.create" ||
          options.currentSessionControl?.createSession !== undefined) &&
        (operation.command !== "session.create-draft" ||
          options.currentSessionControl?.createDraftSession !== undefined) &&
        (operation.command !== "sessions.create-child" ||
          options.currentSessionControl?.createChildSession !== undefined) &&
        (!operation.command.startsWith("sessions.") ||
          operation.command === "sessions.create-child" ||
          options.currentSessionControl?.invokeAppControl !== undefined),
    );
  };
  let fastMode = options.fastMode?.get() ?? false;
  let currentModel: FastModeModel | undefined;
  const fastModeEnabled = () => fastMode && supportsFastMode(currentModel);
  interface RuntimeIdentity {
    sessionId?: string;
  }
  const runtimeIdentity: RuntimeIdentity = {};
  const readOnlyAuxiliary =
    Boolean(options.auxiliary) &&
    !(options.tools ?? []).some((tool) => tool === "bash" || tool === "edit" || tool === "write");
  const filterRuntimeOperations = (definitions: CakeOperationDefinition[]) =>
    readOnlyAuxiliary
      ? definitions.filter((definition) =>
          ["session.info", "session.usage", "context.status"].includes(definition.command),
        )
      : definitions;
  const resolveApiModel = (selection: CakeModelSelection | undefined) => {
    if (!operationApi.current) throw new Error("The Cake session is not ready");
    return operationApi.current.resolveModelSelection(selection);
  };
  const globalControl = options.globalControl;
  const detectedWorktree = globalControl ? undefined : await detectGitWorktree(options.cwd);
  const detectedWorktreePrompt = detectedWorktree
    ? worktreeSystemPrompt(detectedWorktree)
    : undefined;
  const resourceLoader = new ReloadableResourceLoader(() => {
    return new DefaultResourceLoader(
      globalControl
        ? {
            cwd: options.cwd,
            agentDir,
            settingsManager,
            extensionFactories: [
              createFastModeExtension(fastModeEnabled),
              createCakeGatewayExtension((pi) =>
                filterRuntimeOperations([
                  ...localOperations(),
                  ...createGlobalControlOperations(globalControl, resolveApiModel),
                  ...(options.modelPresets ? createCakeModelOperations(options.modelPresets) : []),
                  ...createCakeArtifactOperations(pi, {
                    persistArtifact,
                    requestArtifact,
                    generateInlineWidget: options.generateInlineWidget,
                  }),
                  ...(options.vscodeControl
                    ? createCakeVscodeOperations(options.vscodeControl)
                    : []),
                  ...(options.worktreeLandingControl
                    ? createCakeWorktreeOperations(options.worktreeLandingControl)
                    : []),
                  ...(options.agentControl
                    ? createAgentControlOperations(
                        options.agentControl,
                        () => runtimeIdentity.sessionId,
                        resolveApiModel,
                      )
                    : []),
                ]),
              ),
              createCakeArtifactExtension({ persistArtifact, requestArtifact }),
            ],
            appendSystemPromptOverride: (base) => [...base, cakeChatSystemPrompt],
          }
        : {
            cwd: options.cwd,
            agentDir,
            settingsManager,
            appendSystemPromptOverride: (base) => [
              ...base,
              cakeProjectSystemPrompt,
              ...(options.additionalSystemPrompt ? [options.additionalSystemPrompt] : []),
              ...(detectedWorktreePrompt ? [detectedWorktreePrompt] : []),
            ],
            additionalSkillPaths: [],
            additionalPromptTemplatePaths: [],
            additionalExtensionPaths: [],
            noExtensions: options.auxiliary,
            noSkills: options.auxiliary,
            noPromptTemplates: options.auxiliary,
            noThemes: options.auxiliary,
            extensionFactories: [
              createFastModeExtension(fastModeEnabled),
              createCakeGatewayExtension((pi) =>
                filterRuntimeOperations([
                  ...localOperations(),
                  ...(options.modelPresets ? createCakeModelOperations(options.modelPresets) : []),
                  ...createCakeArtifactOperations(pi, {
                    persistArtifact,
                    requestArtifact,
                    generateInlineWidget: options.generateInlineWidget,
                  }),
                  ...(options.vscodeControl
                    ? createCakeVscodeOperations(options.vscodeControl)
                    : []),
                  ...(options.worktreeLandingControl
                    ? createCakeWorktreeOperations(options.worktreeLandingControl)
                    : []),
                  ...(options.agentControl
                    ? createAgentControlOperations(
                        options.agentControl,
                        () => runtimeIdentity.sessionId,
                        resolveApiModel,
                      )
                    : []),
                ]),
              ),
              createCakeArtifactExtension({ persistArtifact, requestArtifact }),
              ...(options.reviewContextPath
                ? [
                    reviewContextExtension(
                      options.reviewContextPath,
                      () => runtimeIdentity.sessionId,
                    ),
                  ]
                : []),
            ],
          },
    );
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.trusted });
  const sessionDir = options.globalControl
    ? resolve(options.sessionDir)
    : cakeWorkspaceSessionDirectory(options.cwd, options.sessionDir);
  const allowedSessionRoot = sessionDir;
  let directSession: SessionManager | undefined;
  if (options.sessionFile) {
    assertSessionPath(options.sessionFile, allowedSessionRoot, "Session file");
    directSession = SessionManager.open(options.sessionFile, sessionDir, options.cwd);
  }
  const requestedSessionFile =
    options.sessionId && !options.newSession
      ? await findSessionFile(
          options.cwd,
          options.sessionId,
          options.sessionDir,
          Boolean(options.globalControl),
        )
      : undefined;
  if (options.sessionId && !options.newSession && !requestedSessionFile && !directSession)
    throw new Error("That session is no longer available");
  const sessionManager = options.newSession
    ? SessionManager.create(
        options.cwd,
        sessionDir,
        options.sessionId ? { id: options.sessionId } : undefined,
      )
    : (directSession ??
      (requestedSessionFile
        ? SessionManager.open(requestedSessionFile, sessionDir, options.cwd)
        : SessionManager.continueRecent(options.cwd, sessionDir)));
  const agentSessionOptions = {
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
  };
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(
    options.tools ? { ...agentSessionOptions, tools: options.tools } : agentSessionOptions,
  );
  const cakeSessionId = session.sessionManager.getSessionId();
  currentModel = session.model;
  runtimeIdentity.sessionId = cakeSessionId;
  let responseRetryTurnDepth = 0;
  const responseRetries = new ResponseRetryController({
    enabled: () => responseRetryTurnDepth > 0 && settingsManager.getRetryEnabled(),
    onRetry: (event) =>
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: retryNotice(event),
      }),
    onFinished: () =>
      options.onEvent({
        type: "part-removed",
        sessionId: cakeSessionId,
        partId: "active-retry",
      }),
  });
  session.agent.streamFunction = responseRetries.wrap(session.agent.streamFunction);
  async function withResponseRetries<T>(operation: () => Promise<T>): Promise<T> {
    responseRetryTurnDepth += 1;
    try {
      return await operation();
    } finally {
      responseRetryTurnDepth -= 1;
    }
  }
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let turnRecoveryFailureDetail: string | undefined;
  let reloadRequested = 0;
  let reloadCompleted = 0;
  let reloadInFlight: Promise<void> | undefined;
  let sessionNamingInFlight = false;
  const sessionNamingController = new AbortController();
  let usageUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  let lastUsageUpdateAt = 0;
  const generateTitle = options.generateSessionTitle;
  const initialCatalog = compatibilityCatalog(
    resourceLoader,
    settingsManager,
    options.cwd,
    agentDir,
  );
  const catalog = {
    ...initialCatalog,
    resources: [...initialCatalog.resources],
    diagnostics: [...initialCatalog.diagnostics],
  };
  interface MutableExtensionUiState {
    statuses: Array<{ key: string; text: string }>;
    title?: string;
  }
  const extensionUiState: MutableExtensionUiState = { statuses: [] };
  const compatibilityDiagnosticKeys = new Set(
    catalog.diagnostics.map((item) => `${item.method ?? ""}:${item.message}`),
  );

  const requestExtensionValue = async (request: RuntimeUiRequest) => options.requestUi(request);
  const extensionUi = createCakeExtensionUiContext({
    request: requestExtensionValue,
    state: extensionUiState,
    emitState: (event) => {
      if (!disposed) options.onEvent({ type: "extension-ui", sessionId: cakeSessionId, event });
    },
    emitIntent: (intent) => {
      if (!disposed) options.emitExtensionUiIntent?.(intent);
    },
    addDiagnostic(method, message) {
      const key = `${method}:${message}`;
      if (compatibilityDiagnosticKeys.has(key)) return;
      compatibilityDiagnosticKeys.add(key);
      const diagnostic: ResourceDiagnostic = {
        id: `compatibility:${method}:${compatibilityDiagnosticKeys.size}`,
        severity: "warning",
        source: "compatibility",
        method,
        message,
      };
      catalog.diagnostics.push(diagnostic);
      if (!disposed) {
        options.onEvent({
          type: "extension-ui",
          sessionId: cakeSessionId,
          event: { kind: "diagnostic", diagnostic },
        });
      }
    },
  });
  await session.bindExtensions({ mode: "rpc", uiContext: extensionUi });

  const modelOptions = async () =>
    (await projectModelCatalog(modelRuntime, getSupportedThinkingLevels)).map(
      ({ supportedThinkingLevels, input, authTypes, ...model }) => ({
        ...model,
        availableThinkingLevels: [...supportedThinkingLevels],
        input: [...input],
        authTypes: [...authTypes],
      }),
    );

  // Reads the live command catalog straight from Pi's current extension runner,
  // session prompt templates, and loaded skills. Deliberately not routed through
  // a captured extension ctx: those go stale across session reloads and would
  // make every snapshot throw (see Pi's assertActive on captured contexts).
  function piCommandCatalog(): SlashCommandInfo[] {
    const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension" as const,
      sourceInfo: command.sourceInfo,
    }));
    const templateCommands = session.promptTemplates.map((template) => ({
      name: template.name,
      description: template.description,
      argumentHint: template.argumentHint,
      source: "prompt" as const,
      sourceInfo: template.sourceInfo,
    }));
    const skillCommands = resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      sourceInfo: skill.sourceInfo,
    }));
    return [...extensionCommands, ...templateCommands, ...skillCommands];
  }

  function currentUsage(): SessionUsage {
    const stats = session.getSessionStats();
    return {
      tokens: stats.tokens,
      cost: stats.cost,
      context: stats.contextUsage
        ? {
            tokens: stats.contextUsage.tokens,
            contextWindow: stats.contextUsage.contextWindow,
            percent: stats.contextUsage.percent,
          }
        : undefined,
    };
  }

  function publishUsageUpdate() {
    if (usageUpdateTimer !== undefined) {
      clearTimeout(usageUpdateTimer);
      usageUpdateTimer = undefined;
    }
    if (disposed) return;
    lastUsageUpdateAt = Date.now();
    options.onEvent({ type: "usage-updated", sessionId: cakeSessionId, usage: currentUsage() });
  }

  function scheduleUsageUpdate() {
    if (disposed || usageUpdateTimer !== undefined) return;
    const delay = Math.max(0, 250 - (Date.now() - lastUsageUpdateAt));
    if (delay === 0) publishUsageUpdate();
    else usageUpdateTimer = setTimeout(publishUsageUpdate, delay);
  }

  async function makeSnapshot(
    onCaptured?: (snapshot: SessionSnapshot) => void,
  ): Promise<SessionSnapshot> {
    // Resolve every asynchronous projection first. Pi can continue emitting live
    // events while these are in flight, so reading mutable session state before
    // an await would let an older snapshot overwrite newer renderer deltas.
    const [sessionFile, models, artifacts] = await Promise.all([
      options.auxiliary
        ? Promise.resolve(undefined)
        : findSessionFile(
            options.cwd,
            cakeSessionId,
            options.sessionDir,
            Boolean(options.globalControl),
          ),
      options.auxiliary ? Promise.resolve([]) : modelOptions(),
      options.auxiliary
        ? Promise.resolve([])
        : (options.listArtifacts?.(projectArtifactPointers(session.sessionManager)) ??
          Promise.resolve([])),
    ]);

    // Capture all mutable Pi-owned state together after the final await. Once
    // this synchronous block starts, no live event can interleave before emit.
    const sessionListed = sessionFile !== undefined;
    const globalSettings = settingsManager.getGlobalSettings();
    const branchParts = projectSessionEntries(session.sessionManager.getBranch(), undefined, {
      live: session.isStreaming,
    });
    const queuedParts = allQueuedParts();
    const snapshot: SessionSnapshot = {
      workspacePath: options.cwd,
      sessionId: cakeSessionId,
      sessionFile: session.sessionFile ?? "",
      sessionListed,
      parts: [
        ...branchParts,
        ...queuedParts,
        // Snapshots must carry live compaction state so navigating away and
        // back keeps the indicator visible while compaction runs.
        ...(session.isCompacting ? [activeCompactionNotice()] : []),
        ...(turnRecoveryFailureDetail ? [recoveryFailureNotice(turnRecoveryFailureDetail)] : []),
      ],
      model: session.model
        ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
        : undefined,
      fastMode: fastModeEnabled(),
      fastModeAvailable: supportsFastMode(session.model),
      models,
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
      piSettings: {
        defaultProvider: settingsManager.getDefaultProvider(),
        defaultModel: settingsManager.getDefaultModel(),
        defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
        autoCompact: session.autoCompactionEnabled,
        autoResizeImages: settingsManager.getImageAutoResize(),
        blockImages: settingsManager.getBlockImages(),
        enableSkillCommands: settingsManager.getEnableSkillCommands(),
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
        transport: settingsManager.getTransport(),
        httpIdleTimeoutMs: settingsManager.getHttpIdleTimeoutMs(),
        hideThinkingBlock: settingsManager.getHideThinkingBlock(),
        mermaidRenderingMode: settingsManager.getMermaidRenderingMode(),
        showCacheMissNotices: settingsManager.getShowCacheMissNotices(),
        collapseChangelog: settingsManager.getCollapseChangelog(),
        quietStartup: settingsManager.getQuietStartup(),
        enableInstallTelemetry: settingsManager.getEnableInstallTelemetry(),
        defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
        doubleEscapeAction: settingsManager.getDoubleEscapeAction(),
        treeFilterMode: settingsManager.getTreeFilterMode(),
        anthropicExtraUsageWarning: settingsManager.getWarnings().anthropicExtraUsage ?? true,
        retryEnabled: globalSettings.retry?.enabled ?? true,
        shellPath: globalSettings.shellPath ?? "",
        shellCommandPrefix: globalSettings.shellCommandPrefix ?? "",
        npmCommand: globalSettings.npmCommand ?? [],
        packages: globalSettings.packages ?? [],
        extensions: globalSettings.extensions ?? [],
        skills: globalSettings.skills ?? [],
        prompts: globalSettings.prompts ?? [],
        reloadPending: reloadCompleted < reloadRequested || Boolean(reloadInFlight),
      } satisfies PiSettings,
      streaming: session.isStreaming,
      diagnostics: [
        ...extensionsResult.errors.map((error) => `${error.path}: ${error.error}`),
        ...(modelFallbackMessage ? [modelFallbackMessage] : []),
      ],
      commands: options.auxiliary
        ? []
        : [
            ...piBuiltinSlashCommands.filter(
              (command) => !options.slashCommands || options.slashCommands.includes(command.name),
            ),
            ...piCommandCatalog(),
          ].flatMap((command) => {
            const parsed = Schema.decodeUnknownOption(slashCommandSchema)(command);
            return Option.isSome(parsed) ? [parsed.value] : [];
          }),
      usage: currentUsage(),
      compatibility: catalog,
      extensionUi: {
        title: extensionUiState.title,
        statuses: extensionUiState.statuses.map((status) => ({ ...status })),
      },
      tree: options.auxiliary ? [] : projectTree(session.sessionManager),
      artifacts,
    };
    // State capture and publication share one synchronous turn. Live events cannot
    // overtake a snapshot after its fields have been read.
    onCaptured?.(snapshot);
    return snapshot;
  }

  async function emitSnapshot(requestId?: string) {
    if (disposed) return;
    await makeSnapshot((snapshot) => {
      if (!disposed) options.onEvent({ type: "snapshot", requestId, snapshot });
    });
  }

  function activeSessionTitle() {
    const firstUserMessage = session.sessionManager
      .getEntries()
      .flatMap((entry) => {
        if (
          entry.type !== "message" ||
          entry.message.role !== "user" ||
          !("content" in entry.message)
        )
          return [];
        return [textFromContent(entry.message.content).trim()];
      })
      .find(Boolean);
    return (session.sessionManager.getSessionName() || firstUserMessage || "New chat").slice(
      0,
      SESSION_TITLE_MAX_LENGTH,
    );
  }

  const loadedSessionTitle = activeSessionTitle();
  if (!options.newSession && loadedSessionTitle !== "New chat")
    await options.sessionMetadata?.setTitle(cakeSessionId, loadedSessionTitle);

  function emitSnapshotInBackground() {
    void emitSnapshot().catch(() => undefined);
  }

  async function drainReloads() {
    if (reloadInFlight) return reloadInFlight;
    if (reloadCompleted >= reloadRequested || session.isStreaming || session.isCompacting) return;
    reloadInFlight = (async () => {
      try {
        while (
          !disposed &&
          reloadCompleted < reloadRequested &&
          !session.isStreaming &&
          !session.isCompacting
        ) {
          const target = reloadRequested;
          options.onEvent({
            type: "part-updated",
            sessionId: cakeSessionId,
            part: {
              id: "pi-reload-status",
              kind: "notice",
              tone: "info",
              title: "Reloading Pi",
              detail: "Refreshing settings, extensions, skills, prompts, and tools.",
            },
          });
          await session.reload();
          reloadCompleted = target;
        }
        if (!disposed && reloadCompleted >= reloadRequested)
          options.onEvent({
            type: "part-removed",
            sessionId: cakeSessionId,
            partId: "pi-reload-status",
          });
      } catch (error) {
        reloadCompleted = reloadRequested;
        if (!disposed)
          options.onEvent({
            type: "part-updated",
            sessionId: cakeSessionId,
            part: {
              id: "pi-reload-status",
              kind: "notice",
              tone: "error",
              title: "Pi reload failed",
              detail: error instanceof Error ? error.message : String(error),
            },
          });
        throw error;
      } finally {
        reloadInFlight = undefined;
        await emitSnapshot();
      }
    })();
    return reloadInFlight;
  }

  async function requestReload() {
    reloadRequested += 1;
    if (session.isStreaming || session.isCompacting) {
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: {
          id: "pi-reload-status",
          kind: "notice",
          tone: "info",
          title: "Pi reload queued",
          detail: "Cake will reload Pi after the current response settles.",
        },
      });
      await emitSnapshot();
      return;
    }
    await drainReloads();
  }

  async function nameSessionFromFirstMessage(currentUserMessage: string) {
    if (disposed || sessionNamingInFlight || session.sessionManager.getSessionName()) return;
    const firstUserMessage = session.sessionManager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
      .filter((message) => message.role === "user")
      .map((message) => textFromContent(message.content).trim())
      .find(Boolean);
    const userText = firstUserMessage || currentUserMessage.trim();
    if (!userText) return;
    await options.sessionMetadata?.setTitle(
      cakeSessionId,
      userText.slice(0, SESSION_TITLE_MAX_LENGTH),
    );

    const utilityModel = options.utilityModel?.();
    if (!utilityModel || !generateTitle) return;

    sessionNamingInFlight = true;
    try {
      const title = await generateTitle({
        utilityModel,
        firstUserMessage: userText,
        signal: AbortSignal.any([sessionNamingController.signal, AbortSignal.timeout(15_000)]),
      });
      if (disposed || !title || session.sessionManager.getSessionName()) return;
      const normalizedTitle = title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
      session.setSessionName(normalizedTitle);
      await options.sessionMetadata?.setTitle(
        cakeSessionId,
        session.sessionManager.getSessionName() ?? normalizedTitle,
      );
      await emitSnapshot();
    } catch {
      // Utility work is opportunistic. The first-message title remains the fallback.
    } finally {
      sessionNamingInFlight = false;
    }
  }

  const activeToolCalls = new Map<
    string,
    {
      input: string;
      command?: string;
      artifactId?: string;
      filePath?: string;
      diff?: string;
      outputContent?: ToolOutputContent[];
    }
  >();
  // Messages submitted while compaction is running. Pi rejects prompts during
  // manual compaction, so Cake holds them here and delivers them when the
  // compaction_end event reports the session is available again.
  let compactionQueue: {
    turnId?: string;
    text: string;
    attachments: Attachment[];
    delivery: "steer" | "follow-up";
    renderUserMessageAsMarkdown: boolean;
  }[] = [];
  const turnCompletions = new RuntimeTurnCompletion();
  const pendingUserPresentations: {
    content: string;
    renderUserMessageAsMarkdown: boolean;
    consumed: boolean;
  }[] = [];
  const projectLiveMessage = createLiveMessageProjector({
    deferProviderErrors: true,
    renderUserMessageAsMarkdown: (message) => {
      if (typeof message !== "object" || message === null) return false;
      const content = textFromContent(Reflect.get(message, "content"));
      return Boolean(
        pendingUserPresentations.find(
          (candidate) => !candidate.consumed && candidate.content === content,
        )?.renderUserMessageAsMarkdown,
      );
    },
  });
  async function deliverTrackedUserMessage(
    content: string,
    renderUserMessageAsMarkdown: boolean,
    deliver: () => Promise<void>,
  ) {
    const pending = { content, renderUserMessageAsMarkdown, consumed: false };
    pendingUserPresentations.push(pending);
    try {
      await deliver();
    } catch (error) {
      if (!pending.consumed) {
        const index = pendingUserPresentations.indexOf(pending);
        if (index >= 0) pendingUserPresentations.splice(index, 1);
      }
      throw error;
    }
  }
  const allQueuedParts = () =>
    projectQueuedMessages(
      session.getSteeringMessages(),
      session.getFollowUpMessages(),
      compactionQueue.map((item) => item.text),
    );
  let queuedPartIds = new Set(allQueuedParts().map((part) => part.id));
  const activeCompactionNotice = (): Extract<UiPart, { kind: "notice" }> => ({
    id: "active-compaction",
    kind: "notice",
    tone: "info",
    title: "Compacting context",
  });
  function syncQueuedParts() {
    const queuedParts = allQueuedParts();
    const nextIds = new Set(queuedParts.map((part) => part.id));
    for (const partId of queuedPartIds) {
      if (!nextIds.has(partId))
        options.onEvent({ type: "part-removed", sessionId: cakeSessionId, partId });
    }
    for (const part of queuedParts)
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
    queuedPartIds = nextIds;
  }
  // The stream adapter replays pre-output throttling and successful empty
  // responses. This hidden continuation remains a bounded fallback for aborted
  // turns and for empty turns when automatic retry is disabled.
  let userAbortRequested = false;
  let turnRecoveryContinuations = 0;
  let resolveOnSettle = false;

  function removeRecoveryNotice() {
    turnRecoveryFailureDetail = undefined;
    options.onEvent({
      type: "part-removed",
      sessionId: cakeSessionId,
      partId: TURN_RECOVERY_NOTICE_PART_ID,
    });
  }

  function recoveryFailureNotice(detail: string): Extract<UiPart, { kind: "notice" }> {
    return {
      id: TURN_RECOVERY_NOTICE_PART_ID,
      kind: "notice",
      tone: "error",
      title: "Response could not be completed",
      detail: `${detail} Automatic recovery stopped. Send another message to retry manually.`,
    };
  }

  function emitRecoveryFailure(detail: string) {
    turnRecoveryFailureDetail = detail;
    options.onEvent({
      type: "part-updated",
      sessionId: cakeSessionId,
      part: recoveryFailureNotice(detail),
    });
  }

  async function continueTurnHidden(content: string) {
    try {
      await withResponseRetries(() =>
        session.sendCustomMessage(
          {
            customType: "cake.turn-recovery",
            content,
            display: false,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        ),
      );
      return true;
    } catch (error) {
      if (!disposed) emitRecoveryFailure(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function handleSettledTurnRecovery() {
    // A user prompt or another run may have started while the settled snapshot
    // was being assembled. It supersedes recovery of the previous turn.
    if (disposed || session.isStreaming) return;
    const last = session.messages.at(-1);
    const failure = classifyTurnFailure(
      last?.role === "assistant" ? last : undefined,
      userAbortRequested,
    );
    if (!failure) {
      if (turnRecoveryContinuations > 0) {
        turnRecoveryContinuations = 0;
        removeRecoveryNotice();
        options.onEvent({
          type: "part-removed",
          sessionId: cakeSessionId,
          partId: INTERRUPTED_TURN_NOTICE_PART_ID,
        });
      }
      return;
    }
    if (
      !settingsManager.getRetryEnabled() ||
      turnRecoveryContinuations >= TURN_RECOVERY_MAX_AUTO_CONTINUATIONS
    ) {
      options.onEvent({
        type: "part-removed",
        sessionId: cakeSessionId,
        partId: INTERRUPTED_TURN_NOTICE_PART_ID,
      });
      emitRecoveryFailure(failure.detail);
      return;
    }
    turnRecoveryContinuations += 1;
    await continueTurnHidden(turnRecoveryPrompt(failure.kind));
  }

  // A dangling tool-result tail is strong evidence of process interruption.
  // Resume it once with hidden context; settled failed assistant tails are not
  // retried when a session is reopened.
  async function resumeInterruptedTurn() {
    if (disposed || session.isStreaming) return;
    const tail = session.messages.at(-1);
    const settledFailure = classifyTurnFailure(tail?.role === "assistant" ? tail : undefined);
    if (settledFailure?.kind === "empty") {
      emitRecoveryFailure(settledFailure.detail);
      return;
    }
    if (!settingsManager.getRetryEnabled() || !shouldAutoResumeInterruptedTurn(session.messages))
      return;
    turnRecoveryContinuations = TURN_RECOVERY_MAX_AUTO_CONTINUATIONS;
    options.onEvent({
      type: "part-updated",
      sessionId: cakeSessionId,
      part: {
        id: INTERRUPTED_TURN_NOTICE_PART_ID,
        kind: "notice",
        tone: "info",
        title: "Resuming interrupted turn",
      },
    });
    if (!(await continueTurnHidden(interruptedTurnResumePrompt)) && !disposed)
      options.onEvent({
        type: "part-removed",
        sessionId: cakeSessionId,
        partId: INTERRUPTED_TURN_NOTICE_PART_ID,
      });
  }
  async function finishSettledTurn() {
    if (resolveOnSettle) {
      await emitSnapshot().catch(() => undefined);
      if (disposed) return;
      // A new prompt may have started while the snapshot was assembled. Keep
      // the request queued for that turn's settled boundary instead.
      if (session.isStreaming) return;
      resolveOnSettle = false;
      try {
        await options.currentSessionControl?.setResolved(true);
        await reportAgentAction("resolve");
      } catch (error) {
        if (disposed) return;
        options.onEvent({
          type: "part-updated",
          sessionId: cakeSessionId,
          part: {
            id: "session-resolution-failed",
            kind: "notice",
            tone: "error",
            title: "Could not resolve session",
            detail: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    await drainReloads().catch(() => undefined);
    // Apply recovery only after the settled snapshot so its transient failure
    // notice cannot be overwritten by that snapshot.
    await emitSnapshot().catch(() => undefined);
    await handleSettledTurnRecovery();
  }

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (disposed) return;
    if (event.type === "agent_start") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: true });
    }
    for (const part of projectLiveMessage(event)) {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
    }
    if (event.type === "message_update" && event.message.role === "assistant") {
      // Pi estimates trailing context from its live message state. Coalesce the
      // high-frequency stream while still keeping Cake's gauge live during output.
      scheduleUsageUpdate();
    }
    if (event.type === "message_end") {
      // Pi persists finalized messages after notifying subscribers. Publish in
      // a microtask so billed totals and context include the completed message.
      queueMicrotask(publishUsageUpdate);
    }
    if (event.type === "tool_execution_start") {
      const call = {
        input: formatToolInput(event.toolName, event.args),
        command: event.toolName === "cake" ? cakeOperationCommand(event.args) : undefined,
        artifactId: toolArtifactId(event.args),
        filePath: toolFilePath(event.toolName, event.args),
      };
      activeToolCalls.set(event.toolCallId, call);
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          ...call,
          state: "running",
        },
      });
    }
    if (event.type === "tool_execution_update") {
      const call = activeToolCalls.get(event.toolCallId) ?? {
        input: formatToolInput(event.toolName, event.args),
        command: event.toolName === "cake" ? cakeOperationCommand(event.args) : undefined,
        artifactId: toolArtifactId(event.args),
        filePath: toolFilePath(event.toolName, event.args),
        diff: undefined,
      };
      const diff = toolResultDiff(event.toolName, event.partialResult) ?? call.diff;
      const outputContent = toolResultOutputContent(event.partialResult) ?? call.outputContent;
      const nextCall = diff || outputContent ? { ...call, diff, outputContent } : call;
      activeToolCalls.set(event.toolCallId, nextCall);
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          ...nextCall,
          output: formatToolResult(event.partialResult),
          state: "running",
        },
      });
    }
    if (event.type === "tool_execution_end") {
      const call = activeToolCalls.get(event.toolCallId);
      activeToolCalls.delete(event.toolCallId);
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: {
          id: boundedProjectionKey(`tool-${event.toolCallId}`),
          kind: "tool",
          name: event.toolName,
          command:
            call?.command ??
            (event.toolName === "cake" ? cakeOperationCommand(event.result) : undefined),
          input: call?.input ?? "",
          output: formatToolResult(event.result),
          artifactId: toolArtifactId(event.result) ?? call?.artifactId,
          filePath: call?.filePath,
          diff: toolResultDiff(event.toolName, event.result) ?? call?.diff,
          outputContent: toolResultOutputContent(event.result) ?? call?.outputContent,
          state: event.isError ? "error" : "success",
        },
      });
    }
    if (event.type === "auto_retry_start") {
      for (const partId of projectLiveMessage.takeLastAssistantPartIds())
        options.onEvent({ type: "part-removed", sessionId: cakeSessionId, partId });
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: retryNotice(event),
      });
    }
    if (event.type === "auto_retry_end")
      options.onEvent({
        type: "part-removed",
        sessionId: cakeSessionId,
        partId: "active-retry",
      });
    if (event.type === "compaction_start") {
      const notice = activeCompactionNotice();
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: event.reason === "manual" ? notice : { ...notice, detail: event.reason },
      });
    }
    if (event.type === "compaction_end") {
      if (event.aborted) {
        options.onEvent({
          type: "part-updated",
          sessionId: cakeSessionId,
          part: {
            id: "active-compaction",
            kind: "notice",
            tone: "warning",
            title: "Compaction cancelled",
            detail: event.errorMessage,
          },
        });
      } else if (event.errorMessage) {
        options.onEvent({
          type: "part-updated",
          sessionId: cakeSessionId,
          part: {
            id: "active-compaction",
            kind: "notice",
            tone: "error",
            title: "Compaction failed",
            detail: event.errorMessage,
          },
        });
      } else {
        options.onEvent({
          type: "part-removed",
          sessionId: cakeSessionId,
          partId: "active-compaction",
        });
        emitSnapshotInBackground();
      }
      // Deliver anything submitted while compaction held the session. A retry
      // is still pending, so wait for the final compaction_end instead.
      if (!event.willRetry) void flushCompactionQueue();
    }
    if (event.type === "queue_update") {
      syncQueuedParts();
    }
    if (event.type === "message_end" && event.message.role === "user") {
      const content = textFromContent(event.message.content);
      turnCompletions.consume(content);
      const presentationIndex = pendingUserPresentations.findIndex(
        (candidate) => candidate.content === content,
      );
      const presentation =
        presentationIndex >= 0
          ? pendingUserPresentations.splice(presentationIndex, 1)[0]
          : undefined;
      if (presentation) {
        presentation.consumed = true;
        if (presentation.renderUserMessageAsMarkdown)
          queueMicrotask(() => {
            if (disposed) return;
            const target = session.sessionManager
              .getEntries()
              .findLast((entry) => entry.type === "message" && entry.message === event.message);
            if (!target) return;
            session.sessionManager.appendCustomEntry(userMessagePresentationEntryType, {
              targetId: target.id,
              renderAs: "markdown",
            });
            emitSnapshotInBackground();
          });
      }
      if (!options.auxiliary) {
        // The user message is not appended to SessionManager until after subscribers run, so
        // pass the event payload while still using the active branch for reopened sessions.
        void nameSessionFromFirstMessage(textFromContent(event.message.content));
      }
    }
    if (event.type === "agent_settled") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: false });
      turnCompletions.settle();
      void finishSettledTurn();
    }
  });
  void resumeInterruptedTurn();

  const runCompact = async (instructions?: string) => {
    if (disposed) throw new Error("The Cake runtime has been disposed");
    if (!session.isStreaming && reloadCompleted < reloadRequested) await drainReloads();
    await session.compact(instructions || undefined);
    await emitSnapshot();
  };

  // Delivers messages that were submitted while compaction held the session.
  // The first message starts a fresh turn when the session is idle; the rest
  // ride the normal steer/follow-up queues of that turn. Hoisted as a function
  // declaration: the compaction_end subscriber above fires it.
  async function flushCompactionQueue() {
    if (disposed || compactionQueue.length === 0) return;
    const queued = compactionQueue;
    compactionQueue = [];
    syncQueuedParts();
    let index = 0;
    for (const item of queued) {
      try {
        const content = promptText(item.text, item.attachments);
        const images = imageContent(item.attachments);
        if (index === 0 && !session.isStreaming) {
          try {
            await deliverTrackedUserMessage(content, item.renderUserMessageAsMarkdown, () =>
              withResponseRetries(() => session.prompt(content, { images, source: "interactive" })),
            );
            if (item.turnId) turnCompletions.finishHandledInput(item.turnId);
            continue;
          } catch (error) {
            // A turn may have started between the check and this call.
            if (!isAlreadyProcessingError(error)) throw error;
          }
        }
        if (item.delivery === "steer")
          await deliverTrackedUserMessage(content, item.renderUserMessageAsMarkdown, () =>
            session.steer(content, images),
          );
        else
          await deliverTrackedUserMessage(content, item.renderUserMessageAsMarkdown, () =>
            session.followUp(content, images),
          );
      } catch {
        // Delivery failed; keep the remainder queued for the next flush.
        compactionQueue.unshift(...queued.slice(index));
        syncQueuedParts();
        break;
      } finally {
        index += 1;
      }
    }
    emitSnapshotInBackground();
  }

  const currentModelSelection = (): ExplicitCakeModelSelection | undefined =>
    session.model
      ? {
          provider: session.model.provider,
          modelId: session.model.id,
          thinkingLevel: session.thinkingLevel,
          fastMode: fastModeEnabled(),
        }
      : undefined;
  const resolveOperationModel = (selection: CakeModelSelection | undefined) =>
    resolveCakeModelSelection(
      selection,
      options.modelPresets?.() ?? { presets: [] },
      currentModelSelection(),
    );

  operationApi.current = {
    resolveModelSelection: resolveOperationModel,
    info() {
      const info: JsonObject = {
        sessionId: cakeSessionId,
        title: activeSessionTitle(),
        workspacePath: options.cwd,
        resolved: options.currentSessionControl?.resolved() ?? false,
        model: {
          provider: session.model?.provider ?? "unknown",
          id: session.model?.id ?? "unknown",
          reasoning: session.thinkingLevel,
        },
      };
      const family = options.currentSessionControl?.familyInfo?.();
      return Schema.decodeUnknownSync(jsonValueSchema)(
        family === undefined ? info : { ...info, family },
      );
    },
    usage() {
      const stats = session.getSessionStats();
      return Schema.decodeUnknownSync(jsonValueSchema)({
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        cacheWriteTokens: stats.tokens.cacheWrite,
        reportedCostUsd: stats.cost,
        pricingCoverage: options.agentControl ? "partial" : session.model ? "complete" : "unknown",
      });
    },
    contextStatus() {
      const context = session.getSessionStats().contextUsage;
      const tokens = context?.tokens ?? 0;
      const limit = context?.contextWindow ?? 1;
      return Schema.decodeUnknownSync(jsonValueSchema)({
        tokens,
        limit,
        remaining: Math.max(0, limit - tokens),
        utilization: tokens / limit,
        measurement: "estimated",
      });
    },
    async compact(instructions) {
      await runCompact(instructions);
      await reportAgentAction("compact");
      return { status: "compacted" };
    },
    async rename(title) {
      const normalizedTitle = title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
      session.setSessionName(normalizedTitle);
      await options.sessionMetadata?.setTitle(
        cakeSessionId,
        session.sessionManager.getSessionName() ?? normalizedTitle,
      );
      await emitSnapshot();
      const committedTitle = session.sessionManager.getSessionName() ?? title.trim();
      await reportAgentAction("rename", committedTitle);
      return {
        sessionId: cakeSessionId,
        title: committedTitle,
      };
    },
    async createSession(input, signal) {
      if (!options.currentSessionControl?.createSession)
        throw new Error("This Cake runtime cannot create project sessions");
      return options.currentSessionControl.createSession(
        { ...input, model: resolveOperationModel(input.model) },
        signal,
      );
    },
    async createDraftSession(input, signal) {
      if (!options.currentSessionControl?.createDraftSession)
        throw new Error("This Cake runtime cannot create project draft sessions");
      return options.currentSessionControl.createDraftSession(
        { ...input, model: resolveOperationModel(input.model) },
        signal,
      );
    },
    async createChildSession(input, requestId, signal) {
      if (!options.currentSessionControl?.createChildSession)
        throw new Error("This Project Session cannot create child sessions");
      const current = session.model;
      if (!current) throw new Error("The calling session does not have a model to inherit");
      return options.currentSessionControl.createChildSession(
        {
          requestId,
          title: input.title,
          initialPrompt: input.initialPrompt,
          placement: input.placement,
          model: resolveOperationModel(input.model),
        },
        signal,
      );
    },
    async invokeAppControl(command, input, signal) {
      const familyResult =
        command === "sessions.send"
          ? await options.currentSessionControl?.routeFamilyMessage?.(input, signal)
          : undefined;
      let result = familyResult;
      if (result === undefined) {
        const invoke = options.currentSessionControl?.invokeAppControl;
        if (!invoke) throw new Error("Cross-session Cake controls are unavailable in this runtime");
        result = await invoke(command, input, signal);
      }
      const receipt = Schema.decodeUnknownOption(crossSessionReceiptSchema)(result);
      if (Option.isSome(receipt)) {
        const count = receipt.value.messageNumber
          ? ` ${receipt.value.messageNumber}${receipt.value.maxMessages ? `/${receipt.value.maxMessages}` : ""}`
          : "";
        await session.sendCustomMessage(
          {
            customType: "Cross-session delivery",
            content: `${receipt.value.status === "queued" ? "Queued" : "Accepted"} message${count} for “${receipt.value.targetTitle}”`,
            display: true,
            details: result,
          },
          { triggerTurn: false },
        );
      }
      return result;
    },
    async setResolved(resolved) {
      if (!options.currentSessionControl)
        throw new Error("This Cake runtime cannot change session resolution");
      if (
        resolved &&
        session.isStreaming &&
        options.currentSessionControl.deferResolution !== false
      ) {
        resolveOnSettle = true;
        return {
          sessionId: cakeSessionId,
          resolved: options.currentSessionControl.resolved(),
          resolveOnSettle: true,
        };
      }
      resolveOnSettle = false;
      await options.currentSessionControl.setResolved(resolved);
      await reportAgentAction(resolved ? "resolve" : "restore");
      return { sessionId: cakeSessionId, resolved, resolveOnSettle: false };
    },
    async setModel(selection) {
      const configuration = resolveOperationModel(selection);
      const model = modelRuntime.getModel(configuration.provider, configuration.modelId);
      if (!model)
        throw new Error(`Unknown model ${configuration.provider}/${configuration.modelId}`);
      const supportedThinkingLevels = getSupportedThinkingLevels(model);
      if (!supportedThinkingLevels.includes(configuration.thinkingLevel))
        throw new Error(
          `Thinking level ${configuration.thinkingLevel} is unavailable for ${configuration.provider}/${configuration.modelId}`,
        );
      if (configuration.fastMode && !supportsFastMode(model))
        throw new Error(
          `Fast mode is unavailable for ${configuration.provider}/${configuration.modelId}`,
        );
      await session.setModel(model);
      currentModel = session.model;
      session.setThinkingLevel(configuration.thinkingLevel);
      if (options.fastMode) await options.fastMode.set(configuration.fastMode);
      fastMode = configuration.fastMode;
      await emitSnapshot();
      await reportAgentAction("set-model", `${configuration.provider}/${configuration.modelId}`);
      return configuration;
    },
  };

  return {
    sessionId: cakeSessionId,
    get sessionFile() {
      return session.sessionFile ?? "";
    },
    get streaming() {
      return session.isStreaming;
    },
    getReviewParentContext() {
      if (!session.sessionFile) throw new Error("The parent session is not persisted");
      const leafId = session.sessionManager.getLeafId() ?? undefined;
      return {
        sessionId: cakeSessionId,
        sessionFile: session.sessionFile,
        leafId,
        systemPrompt: session.systemPrompt,
        activeTools: session.getActiveToolNames(),
        model: session.model
          ? { provider: session.model.provider, id: session.model.id }
          : undefined,
      };
    },
    recordReviewRun(run) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const parsed = Schema.decodeUnknownSync(reviewRunEntrySchema)(run);
      session.sessionManager.appendCustomEntry(reviewRunEntryType, parsed);
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: reviewRunPart(parsed),
      });
    },
    snapshot: () => makeSnapshot(),
    async notifySubagentCompletion(result) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      await session.sendCustomMessage(
        {
          customType: "cake.subagent-completion",
          content: `A background subagent completed. Use this result to continue the user's work:\n\n${formatUnknown(result, 24_000)}`,
          display: false,
          details: result,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
    compact: (instructions) => runCompact(instructions),
    executingTurnIds: () => turnCompletions.executingIds(),
    async prompt(text, delivery, attachments, renderUserMessageAsMarkdown = false, turnId) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      // A real user submission starts a fresh bounded recovery budget.
      userAbortRequested = false;
      turnRecoveryContinuations = 0;
      removeRecoveryNotice();
      const builtin = parsePiBuiltinCommand(text);
      if (builtin?.name === "compact") {
        await runCompact(builtin.args || undefined);
        return;
      }
      const shellPrefix = text.startsWith("!!") ? "!!" : text.startsWith("!") ? "!" : undefined;
      const shellCommand = shellPrefix ? text.slice(shellPrefix.length).trim() : "";
      if (shellPrefix && attachments.length === 0) {
        if (!shellCommand) return;
        const partId = `bash-${randomUUID()}`;
        const excludeFromContext = shellPrefix === "!!";
        let output = "";
        const project = (state: "running" | "success" | "error") =>
          options.onEvent({
            type: "part-updated",
            sessionId: cakeSessionId,
            part: shellCommandPart({
              id: partId,
              command: shellCommand,
              output: output.slice(-500_000),
              excludeFromContext,
              state,
            }),
          });
        project("running");
        const result = await session.executeBash(
          shellCommand,
          (chunk) => {
            output += chunk;
            project("running");
          },
          { excludeFromContext, id: partId },
        );
        project(result.exitCode === 0 && !result.cancelled ? "success" : "error");
        await emitSnapshot();
        return;
      }
      if (!session.isStreaming && reloadCompleted < reloadRequested) await drainReloads();
      const completion = turnId
        ? turnCompletions.track(
            turnId,
            promptText(text, attachments),
            (delivery === "prompt" && !session.isStreaming) || text.startsWith("/"),
          )
        : undefined;
      try {
        if (session.isCompacting) {
          // Pi rejects prompts during compaction. Hold the message with its
          // delivery intent and deliver it when compaction finishes instead of
          // failing the submission.
          compactionQueue.push({
            turnId,
            text,
            attachments,
            // A plain "prompt" intent degrades to a follow-up when it has to
            // wait behind compaction; steering intent is preserved.
            delivery: delivery === "steer" ? "steer" : "follow-up",
            renderUserMessageAsMarkdown,
          });
          syncQueuedParts();
          await completion;
          return;
        }
        const content = promptText(text, attachments);
        const images = imageContent(attachments);
        if (delivery === "steer")
          await deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
            session.steer(content, images),
          );
        else if (delivery === "follow-up")
          await deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
            session.followUp(content, images),
          );
        else if (session.isStreaming) {
          // The renderer may see a stale idle snapshot while a turn is still
          // running. Queue the message instead of failing the submission.
          await deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
            session.followUp(content, images),
          );
        } else {
          try {
            await deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
              withResponseRetries(() => session.prompt(content, { images, source: "interactive" })),
            );
          } catch (error) {
            // The turn may have started between the check and this call.
            if (!isAlreadyProcessingError(error)) throw error;
            await deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
              session.followUp(content, images),
            );
          }
        }
        // Pi extensions may handle input without creating a user message or run.
        if (
          turnId &&
          !session.isStreaming &&
          !session.isCompacting &&
          session.getSteeringMessages().length === 0 &&
          session.getFollowUpMessages().length === 0
        )
          turnCompletions.finishHandledInput(turnId);
        await completion;
      } finally {
        if (turnId) turnCompletions.forget(turnId);
      }
    },
    async listQueuedMessages() {
      return {
        steering: [
          ...session.getSteeringMessages(),
          ...compactionQueue
            .filter((message) => message.delivery === "steer")
            .map((message) => message.text),
        ],
        followUp: [
          ...session.getFollowUpMessages(),
          ...compactionQueue
            .filter((message) => message.delivery === "follow-up")
            .map((message) => message.text),
        ],
      };
    },
    async clearQueue() {
      const queued = session.clearQueue();
      turnCompletions.cancel(true);
      const steering = [
        ...queued.steering,
        ...compactionQueue
          .filter((message) => message.delivery === "steer")
          .map((message) => message.text),
      ];
      const followUp = [
        ...queued.followUp,
        ...compactionQueue
          .filter((message) => message.delivery === "follow-up")
          .map((message) => message.text),
      ];
      compactionQueue = [];
      syncQueuedParts();
      await emitSnapshot();
      return { steering, followUp };
    },
    async setUserMessageMarkdown(entryId, renderAsMarkdown) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const target = session.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" && entry.id === entryId && entry.message.role === "user",
        );
      if (!target) throw new Error("The user message is not in the active conversation");
      const presentation = Schema.decodeUnknownSync(userMessagePresentationEntrySchema)({
        targetId: entryId,
        renderAs: renderAsMarkdown ? "markdown" : "plain",
      });
      session.sessionManager.appendCustomEntry(userMessagePresentationEntryType, presentation);
      await emitSnapshot();
    },
    async editMessage(entryId, text, attachments, renderUserMessageAsMarkdown) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      if (session.isStreaming || session.isCompacting)
        throw new Error("Wait for the current response to finish before editing a message");
      const lastUserEntry = session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "user");
      if (!lastUserEntry || lastUserEntry.id !== entryId)
        throw new Error("Only the last user message can be edited");
      userAbortRequested = false;
      turnRecoveryContinuations = 0;
      removeRecoveryNotice();
      const result = await session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("Message editing was cancelled");
      await emitSnapshot();
      const content = promptText(text, attachments);
      const images = imageContent(attachments);
      await deliverTrackedUserMessage(content, renderUserMessageAsMarkdown, () =>
        withResponseRetries(() => session.prompt(content, { images, source: "interactive" })),
      );
    },
    abort: () => {
      turnCompletions.cancel();
      userAbortRequested = true;
      turnRecoveryContinuations = 0;
      removeRecoveryNotice();
      responseRetries.cancel();
      if (session.isBashRunning) {
        session.abortBash();
        return Promise.resolve();
      }
      return session.abort();
    },
    async setModel(provider, modelId) {
      const model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
      await session.setModel(model);
      currentModel = session.model;
      await emitSnapshot();
    },
    async setThinkingLevel(level) {
      session.setThinkingLevel(level);
      await emitSnapshot();
    },
    async applyConfiguration(configuration) {
      const model = modelRuntime.getModel(configuration.provider, configuration.modelId);
      if (!model)
        throw new Error(`Unknown model ${configuration.provider}/${configuration.modelId}`);
      await session.setModel(model);
      currentModel = session.model;
      session.setThinkingLevel(configuration.thinkingLevel);
      // Fast mode is best-effort: a preset may carry a fast flag for a model that
      // no longer supports it. Skip it instead of failing the whole configuration,
      // matching the previous per-step setters where only fast mode could fail.
      if (!configuration.fastMode || supportsFastMode(model)) {
        if (options.fastMode) await options.fastMode.set(configuration.fastMode);
        fastMode = configuration.fastMode;
      }
      await emitSnapshot();
    },
    async setFastMode(enabled) {
      if (enabled && !supportsFastMode(session.model))
        throw new Error("Fast mode is unavailable for the current model");
      if (options.fastMode) await options.fastMode.set(enabled);
      fastMode = enabled;
      await emitSnapshot();
    },
    async syncFastMode() {
      // Syncs state only; callers publish the synced state in their own snapshot
      // so a freshly created runtime never emits its pre-configuration model.
      if (options.fastMode) fastMode = options.fastMode.get();
    },
    async setPiSetting(update) {
      applyPiSetting(settingsManager, session, update);
      if (update.key === "retryEnabled" && !update.value) responseRetries.cancel();
      await settingsManager.flush();
      await emitSnapshot();
    },
    reload: requestReload,
    async refreshModels() {
      // Runtime catalogs sync from the shared models store on disk. The single
      // network pass is performed on the shared agent catalog by the main
      // process, which then calls this on every live runtime so already-open
      // sessions accept models surfaced by the refresh without a restart.
      await modelRuntime.refresh({ allowNetwork: false });
      await emitSnapshot();
    },
    async login(provider, authType) {
      await modelRuntime.login(provider, authType, {
        async prompt(prompt) {
          const value = await requestExtensionValue({
            kind: prompt.type,
            title: "Provider authentication",
            message: prompt.message,
            placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
            options:
              prompt.type === "select"
                ? prompt.options.map((option) => ({ id: option.id, label: option.label }))
                : undefined,
            signal: prompt.signal,
          });
          if (value === undefined) throw new Error("Authentication cancelled");
          return value;
        },
        notify(event) {
          const detail =
            event.type === "auth_url"
              ? event.url
              : event.type === "device_code"
                ? `${event.verificationUri}\nCode: ${event.userCode}`
                : event.message;
          options.onEvent({
            type: "part-updated",
            sessionId: cakeSessionId,
            part: {
              id: "auth-status",
              kind: "notice",
              tone: "info",
              title: "Authentication",
              detail,
            },
          });
          const url =
            event.type === "auth_url"
              ? event.url
              : event.type === "device_code"
                ? event.verificationUri
                : undefined;
          if (url && options.openExternal) {
            void options.openExternal(url).catch((error) => {
              options.onEvent({
                type: "part-updated",
                sessionId: cakeSessionId,
                part: {
                  id: "auth-status",
                  kind: "notice",
                  tone: "error",
                  title: "Could not open authentication",
                  detail: `${error instanceof Error ? error.message : String(error)}\n${detail}`,
                },
              });
            });
          }
        },
      });
      await emitSnapshot();
    },
    async logout(provider) {
      const status = modelRuntime.getProviderAuthStatus(provider);
      if (
        status.configured &&
        status.source &&
        status.source !== "stored" &&
        status.source !== "runtime"
      ) {
        throw new Error(
          `${status.label ?? provider} is managed outside Cake. Remove that credential source and restart Cake to disconnect it.`,
        );
      }
      await modelRuntime.logout(provider);
      await emitSnapshot();
    },
    async rename(name) {
      const normalizedName = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
      session.setSessionName(normalizedName);
      await options.sessionMetadata?.setTitle(
        cakeSessionId,
        session.sessionManager.getSessionName() ?? normalizedName,
      );
      await emitSnapshot();
    },
    async fork(entryId) {
      const sessionFile = session.sessionManager.createBranchedSession(entryId);
      if (!sessionFile) throw new Error("The current session is not persisted");
      const forked = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
      return { sessionId: forked.getSessionId(), sessionFile };
    },
    async handoff(entryId, destination) {
      const configuration = session.model
        ? {
            provider: session.model.provider,
            modelId: session.model.id,
            thinkingLevel: session.thinkingLevel,
          }
        : undefined;
      const title = activeSessionTitle();
      const handedOff = createConversationHandoff(
        session.sessionManager,
        entryId,
        configuration,
        destination
          ? {
              workingDirectory: destination.workingDirectory,
              sessionDirectory: cakeWorkspaceSessionDirectory(
                destination.workingDirectory,
                destination.sessionRoot,
              ),
            }
          : undefined,
        title,
      );
      await options.sessionMetadata?.setTitle(handedOff.sessionId, title);
      return handedOff;
    },
    async navigate(entryId) {
      const result = await session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("Session tree navigation was cancelled");
      await emitSnapshot();
    },
    dispose() {
      if (disposed) return disposePromise;
      disposed = true;
      turnCompletions.cancel();
      sessionNamingController.abort();
      if (usageUpdateTimer !== undefined) clearTimeout(usageUpdateTimer);
      usageUpdateTimer = undefined;
      responseRetries.cancel();
      unsubscribe();
      const finish = async () => {
        session.dispose();
        await settingsManager.flush();
      };
      // Graceful teardown: while a run is active, abort first so Pi unwinds
      // through its normal failure path and persists the "aborted" marker.
      // The returned Promise settles only after Pi disposal and settings flush,
      // so a scoped owner cannot reacquire this transcript during teardown.
      disposePromise = session.isStreaming
        ? session
            .abort()
            .catch(() => undefined)
            .then(finish)
        : finish();
      return disposePromise;
    },
  };
}
