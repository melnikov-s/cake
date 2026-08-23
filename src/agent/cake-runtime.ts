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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type {
  Attachment,
  ModelOption,
  PiSettings,
  PiSettingUpdate,
  ExtensionUiEvent,
  ExtensionUiState,
  ResourceDiagnostic,
  SessionSnapshot,
  ThinkingLevel,
  ToolOutputContent,
  UiPart,
  UtilityModel,
} from "../ipc/session-contract";
import {
  SESSION_TITLE_MAX_LENGTH,
  parsePiBuiltinCommand,
  piBuiltinSlashCommands,
  slashCommandSchema,
} from "../ipc/session-contract";
import { jsonValueSchema, type JsonObject, type JsonValue } from "../ipc/json-contract";
import {
  artifactRecordSchema,
  type ArtifactRecord,
  type ArtifactPointer,
  type CakeArtifactV1,
} from "../ipc/artifact-contract";
import type { TSchema } from "@earendil-works/pi-ai";
import { createCakeArtifactExtension } from "./artifact-extension";
import {
  INTERRUPTED_TURN_NOTICE_PART_ID,
  TURN_RECOVERY_MAX_AUTO_CONTINUATIONS,
  TURN_RECOVERY_NOTICE_PART_ID,
  classifyTurnFailure,
  interruptedTurnResumePrompt,
  shouldAutoResumeInterruptedTurn,
  turnRecoveryPrompt,
} from "./turn-recovery";
import { applyFastModePayload, supportsFastMode, type FastModeModel } from "./fast-mode";
import { compatibilityCatalog, createCakeExtensionUiContext } from "./extension-compatibility";
import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
  ReviewParentContext,
} from "./sidecar-runtime";
import { assertSessionPath } from "./session-path";
import { RateLimitRetryController } from "./rate-limit-retry";
import { applyPiSetting } from "./settings-translation";
import {
  cakePluginAuthoringSkillPath,
  cakeWorkspaceSessionDirectory,
  listWorkspaceSessions,
} from "./session-discovery";
import { generateSessionTitle } from "./utility-model";
import {
  parallelSubagentSchema,
  subagentTaskSchema,
  type ParallelSubagentTasks,
  type ParallelSubagentTasksInput,
  type SubagentTask,
  type SubagentTaskInput,
} from "./subagent-contract";
import {
  boundedProjectionKey,
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
  textFromContent,
  toolArtifactId,
  toolFilePath,
  toolResultOutputContent,
  toolResultDiff,
  type ReviewRunEntry,
} from "./session-projection";

export const piRuntimeVersion = "0.84.0" as const;
const cakeChatSystemPrompt = `## Cake Chat

You are Cake Chat, the built-in assistant of Cake, a desktop application powered by Pi. You are the user's home base with two jobs: a general-purpose agent for their machine, and an operator of Cake itself.

Machine work: your working directory is the user's home directory and you have the full standard toolset (read, edit, bash, and the rest). Use it for configuration changes, file management, Git, subprocesses, and any other work on the machine.

Cake work: you also have curated application tools for the running Cake app. Their effects exist only inside the app and cannot be produced any other way — do not try to simulate them in a shell:
- get_app_state and get_session_status report live state (selection, running/unread activity, resolved flags) that exists only in the app, never on disk.
- open_session, create_session, send_session_message, abort_session, rename_session, set_session_resolved, set_sessions_resolved, set_cake_chat_sessions_resolved, and set_session_model act on sessions.
- The customization and plugin tools author, validate, activate, roll back, enable, disable, and inspect Cake customizations.

Session transcripts are Pi JSONL files under the Cake home directory:
- Project sessions: ~/.cake/pi/sessions/--<workspace path with separators replaced by dashes>--/
- Cake Chat sessions: ~/.cake/pi/global-chat/sessions/
- Review, widget, and plugin-agent transcripts live alongside under ~/.cake/pi/review-sessions/, widget-sessions/, and plugin-agent-sessions/.

Search and read transcripts freely with rg, jq, or grep to answer questions about past work. Every file under ~/.cake is Cake-owned state: treat it as read-only. Never edit, move, or delete transcripts, settings, or plugin state there, and never try to influence a session by modifying its files — act through the application tools instead.

Earlier messages are part of the conversation; resolve follow-up references from them. Refresh live application state with tools when it may have changed. Never claim an action succeeded unless its tool result says it did.

For Cake customizations, choose the execution path deliberately: deterministic network, filesystem, Git, Bash, and subprocess work belongs in an unrestricted plugin backend; bounded summaries, classification, and extraction belong in usePluginCompletion; open-ended multi-turn tool work belongs in usePluginAgent. Delegated inline widgets never receive these trusted capabilities.

When the user asks you to create or change a Cake plugin, widget, scene, or other customization, that request authorizes the complete authoring loop. First call get_plugin_authoring_reference; it is the exact API for this Cake version, so never use compiler errors or speculative writes to discover the API. Inspect customization state and plugin files, create or edit plugin-owned source, validate it, and inspect every diagnostic. Ordinary widgets are renderer plugins and must not create or select a scene. A plugin scene is only for an explicit request to replace the whole application scene. Slot namespaces are ownership boundaries: global.* is application chrome across Cake Chat, project sessions, and settings, while project-session.* exists only inside a selected project session. project-session.header.actions is the toolbar/menu row. Persistent session panels use the normal-flow project-session.left.top, project-session.left.middle, project-session.left.bottom, project-session.right.top, project-session.right.middle, and project-session.right.bottom rails; "top right of the session" means project-session.right.top. Rail contributions reserve space and must not position themselves over the conversation. Header slots are fixed-height action rows; contribute a compact trigger there. When temporary UI should intentionally overlap, use Cake's Popover, PopoverTrigger, and PopoverContent instead of plugin-owned absolute or fixed positioning. A failed typecheck or bundle is intermediate authoring feedback: fix the source and validate again autonomously. Validation never changes the running UI. Call activate_customization only after the requested implementation is complete and validation succeeds. Do not stop to report ordinary authoring diagnostics or ask whether the user wants you to fix them. Treat responsive, collision-free layout as an authoring acceptance criterion: custom scenes and widgets must reflow without overlapping text, controls, icons, navigation, or Cake-owned children from 320 CSS pixels through wide desktop sizes and with long labels or values. Use normal-flow flex or grid layout that wraps, reserve space for icons and decorations, and avoid absolute or fixed positioning for structural content. Stop only when the customization succeeds or you are genuinely blocked by missing user intent, unavailable capability, or a conflict you cannot safely resolve. A failure reported for a previously activated customization is a recovery event that you may surface before the user requests repair; once they ask for repair, carry that repair through the same autonomous edit-validate-activate loop.`;

const cakeProjectSystemPrompt = `## Cake desktop environment

You are running inside Cake, a desktop interface powered by Pi. Your messages, tool activity, and rich outputs are rendered in Cake rather than Pi's terminal UI. Keep the conversation as the primary interface and continue using Pi's tools, skills, extensions, project context, and session behavior normally. Do not direct the user to terminal-only UI controls.

Cake streams GitHub-flavored Markdown, syntax-highlighted code blocks, mathematical notation, and Mermaid diagrams directly in the transcript. Prefer these inline formats when they communicate the result clearly. Do not use an artifact merely to style content that Markdown, tables, code blocks, math, or Mermaid can express.

For standalone deliverables such as PowerPoint presentations, PDFs, spreadsheets, documents, images, audio, or video, use the available Pi tools and skills and link the resulting workspace file in Markdown. Do not recreate a file deliverable as decorative HTML.

Cake can delegate one-off visual explanations to a separate widget agent. Use ui_widget when an interactive or highly visual presentation materially improves the explanation and Markdown, a table, or Mermaid is insufficient. Provide a self-contained presentation brief, all required data, and a readable Markdown fallback; do not write React or HTML yourself. Generated React widgets may use the approved, bundled D3 modules ('d3' or 'd3-*') for local SVG/canvas/DOM visualizations; they still have no network, parent, Cake, Node, Electron, or filesystem access. Cake generates and stores the implementation outside this conversation context, then renders the sandboxed widget at the tool-call position. Prefer ordinary transcript content for simple or primarily textual explanations.

Do not use subagent tools unless the user explicitly asks for subagents, delegation, or parallel agent work. The presence of delegation tools is not permission to use them. Handle ordinary research, implementation, review, and testing yourself.

Use ui_request only when the running turn must block and receive validated user input. Pass one cake.request/v1 request with a unique ID, a responseSchema, a readable Markdown fallback, and either a form view or a widget view. Prefer the form view for ordinary fields. Use a widget view only for a genuinely visual interaction; HTML widget source calls cakeRequest.submit(value) or cakeRequest.cancel(), while a React widget component receives { submit, cancel } props. Custom request widgets have the same isolation as inline widgets. Do not call ui_request for content that can be presented in the assistant message.

When referencing workspace files, use Markdown links with absolute paths so Cake can open them.`;
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
  | { type: "extension-ui"; sessionId: string; event: ExtensionUiEvent };

export interface CakeRuntimeOptions {
  cwd: string;
  trusted: boolean;
  agentDir: string;
  sessionDir: string;
  newSession?: boolean;
  sessionId?: string;
  sessionFile?: string;
  pluginResources?: { skills: string[]; prompts: string[]; extensions: string[] };
  additionalSystemPrompt?: string;
  tools?: string[];
  auxiliary?: boolean;
  /** Subset of builtin slash command names to advertise; defaults to all of them. */
  slashCommands?: readonly string[];
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  persistArtifact?(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact?(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
  listArtifacts?(pointers: ArtifactPointer[]): Promise<ArtifactRecord[]>;
  openExternal?(url: string): Promise<void>;
  reviewContextPath?(sessionId: string): string;
  utilityModel?(): UtilityModel | undefined;
  fastMode?: {
    get(): boolean;
    set(enabled: boolean): Promise<void>;
  };
  generateSessionTitle?: typeof generateSessionTitle;
  globalControl?: {
    tools: readonly GlobalControlTool[];
    recoveryContext?: string;
    invoke(input: { name: string; arguments: JsonValue }, signal: AbortSignal): Promise<JsonValue>;
  };
  agentControl?: {
    spawn(
      input: SubagentTaskInput,
      parentSessionId: string,
      signal: AbortSignal,
    ): Promise<JsonValue>;
    parallel(
      input: ParallelSubagentTasksInput,
      parentSessionId: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
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

export interface GlobalControlTool {
  name: string;
  description: string;
  parameters: JsonObject;
}

/** Pi throws this when a plain prompt arrives while the agent turn is streaming. */
function isAlreadyProcessingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Agent is already processing. Specify streamingBehavior")
  );
}

function retryDelayDetail(delayMs: number, errorMessage: string): string {
  const seconds = Math.ceil(delayMs / 1_000);
  const duration =
    seconds < 60
      ? `${seconds} second${seconds === 1 ? "" : "s"}`
      : seconds < 3_600
        ? `${Math.ceil(seconds / 60)} minute${seconds <= 60 ? "" : "s"}`
        : `${Math.ceil(seconds / 3_600)} hour${seconds <= 3_600 ? "" : "s"}`;
  const retryAt = new Date(Date.now() + delayMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: delayMs < 60_000 ? "2-digit" : undefined,
  });
  return `${errorMessage}\nNext retry in ${duration}, at ${retryAt}. Press Stop to cancel.`;
}

function createFastModeExtension(isEnabled: () => boolean): InlineExtension {
  return (pi) => {
    pi.on("before_provider_request", (event, context) =>
      applyFastModePayload(event.payload, context.model, isEnabled()),
    );
  };
}

function createGlobalControlExtension(
  control: NonNullable<CakeRuntimeOptions["globalControl"]>,
): InlineExtension {
  return (pi) => {
    for (const tool of control.tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.name.replaceAll("_", " "),
        description: tool.description,
        // SAFETY: appControlToolCatalog produced this JSON Schema through
        // z.toJSONSchema; Pi's TSchema input consumes that same schema shape.
        parameters: tool.parameters as TSchema,
        async execute(_toolCallId, params, signal) {
          const result = await control.invoke(
            { name: tool.name, arguments: jsonValueSchema.parse(params) },
            signal ?? new AbortController().signal,
          );
          return {
            content: [{ type: "text", text: formatUnknown(result, 24_000) }],
            details: result,
          };
        },
      });
    }
  };
}

function createAgentControlExtension(
  control: NonNullable<CakeRuntimeOptions["agentControl"]>,
  parentSessionId: () => string | undefined,
): InlineExtension {
  const promptSchema = z.object({ handleId: z.uuid(), text: z.string().min(1).max(262_144) });
  const handleSchema = z.object({ handleId: z.uuid() });
  const tools = [
    {
      name: "subagent_spawn",
      description:
        "Use only when the user explicitly requested subagents or delegation. Start one isolated, parent-owned subagent with an explicit capability profile. Delegation depth is zero and completed runtimes are released by default; set retain only for intentional multi-turn work.",
      schema: subagentTaskSchema,
      run: (value: SubagentTask, parent: string, signal: AbortSignal) =>
        control.spawn(value, parent, signal),
    },
    {
      name: "subagent_parallel",
      description:
        "Use only when the user explicitly requested parallel agent work. Run up to eight bounded subagent tasks with a workspace-wide active concurrency limit and return all results.",
      schema: parallelSubagentSchema,
      run: (
        value: ParallelSubagentTasks,
        parent: string,
        signal: AbortSignal,
        onUpdate?: (value: JsonValue) => void,
      ) => control.parallel(value, parent, signal, onUpdate),
    },
    {
      name: "subagent_prompt",
      description: "Send a normal prompt to an idle subagent and wait for its turn.",
      schema: promptSchema,
      run: (value: z.infer<typeof promptSchema>, parent: string, signal: AbortSignal) =>
        control.prompt({ ...value, delivery: "prompt" }, parent, signal),
    },
    {
      name: "subagent_follow_up",
      description: "Queue a follow-up for a subagent using Pi's normal queue policy.",
      schema: promptSchema,
      run: (value: z.infer<typeof promptSchema>, parent: string, signal: AbortSignal) =>
        control.prompt({ ...value, delivery: "follow-up" }, parent, signal),
    },
    {
      name: "subagent_wait",
      description:
        "Wait for a subagent and stream its latest tool activity, usage, and final result.",
      schema: handleSchema,
      run: (
        value: z.infer<typeof handleSchema>,
        parent: string,
        signal: AbortSignal,
        onUpdate?: (value: JsonValue) => void,
      ) => control.wait(value.handleId, parent, signal, onUpdate),
    },
    {
      name: "subagent_abort",
      description: "Abort active work in a subagent.",
      schema: handleSchema,
      run: (value: z.infer<typeof handleSchema>, parent: string) =>
        control.abort(value.handleId, parent),
    },
    {
      name: "subagent_close",
      description: "Release a subagent handle and its hidden runtime when it is no longer needed.",
      schema: handleSchema,
      run: (value: z.infer<typeof handleSchema>, parent: string) =>
        control.close(value.handleId, parent),
    },
  ];
  return (pi) => {
    for (const tool of tools) {
      // SAFETY: Pi's TSchema input and Zod's JSON Schema output share the JSON Schema shape used by every Cake inline extension.
      const parameters = z.toJSONSchema(tool.schema) as TSchema;
      pi.registerTool({
        name: tool.name,
        label: tool.name.replaceAll("_", " "),
        description: tool.description,
        parameters,
        async execute(_toolCallId, params, signal, onUpdate) {
          const parent = parentSessionId();
          if (!parent) throw new Error("The parent Cake session is not ready");
          const update = (value: JsonValue) =>
            onUpdate?.({
              content: [{ type: "text", text: formatUnknown(value, 24_000) }],
              details: value,
            });
          // SAFETY: Each run callback is paired with the schema that parsed this value in the local tools table above.
          const result = await tool.run(
            tool.schema.parse(params) as never,
            parent,
            signal ?? new AbortController().signal,
            update,
          );
          return {
            content: [{ type: "text", text: formatUnknown(result, 24_000) }],
            details: result,
          };
        },
      });
    }
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
  getReviewParentContext?(): ReviewParentContext;
  recordReviewRun(run: ReviewRunEntry): void;
  snapshot(requestId?: string): Promise<SessionSnapshot>;
  prompt(
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
  ): Promise<void>;
  compact(instructions?: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setFastMode?(enabled: boolean): Promise<void>;
  syncFastMode?(): Promise<void>;
  setPiSetting(update: PiSettingUpdate): Promise<void>;
  reload?(): Promise<void>;
  refreshModels?(): Promise<void>;
  login(provider: string, authType: "api_key" | "oauth"): Promise<void>;
  logout(provider: string): Promise<void>;
  rename(name: string): Promise<void>;
  fork(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  navigate(entryId: string): Promise<void>;
  dispose(): void;
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
      artifactRecordSchema.parse({
        artifact,
        workspacePath: options.cwd,
        digest: "0".repeat(64),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
  const requestArtifact = options.requestArtifact ?? (async () => undefined);
  let fastMode = options.fastMode?.get() ?? false;
  let currentModel: FastModeModel | undefined;
  const fastModeEnabled = () => fastMode && supportsFastMode(currentModel);
  let getPiCommands: () => SlashCommandInfo[] = () => [];
  interface RuntimeIdentity {
    sessionId?: string;
  }
  const runtimeIdentity: RuntimeIdentity = {};
  const commandCatalogExtension: InlineExtension = (pi) => {
    getPiCommands = () => pi.getCommands();
  };
  const globalControl = options.globalControl;
  const resourceLoader = new DefaultResourceLoader(
    globalControl
      ? {
          cwd: options.cwd,
          agentDir,
          settingsManager,
          additionalSkillPaths: [cakePluginAuthoringSkillPath()],
          extensionFactories: [
            createFastModeExtension(fastModeEnabled),
            createGlobalControlExtension(globalControl),
            commandCatalogExtension,
          ],
          appendSystemPromptOverride: (base) => [
            ...base,
            globalControl.recoveryContext
              ? `${cakeChatSystemPrompt}\n\nCustomization recovery context from immutable Cake core:\n${globalControl.recoveryContext}`
              : cakeChatSystemPrompt,
          ],
        }
      : {
          cwd: options.cwd,
          agentDir,
          settingsManager,
          appendSystemPromptOverride: (base) => [
            ...base,
            cakeProjectSystemPrompt,
            ...(options.additionalSystemPrompt ? [options.additionalSystemPrompt] : []),
          ],
          additionalSkillPaths: options.auxiliary
            ? []
            : [cakePluginAuthoringSkillPath(), ...(options.pluginResources?.skills ?? [])],
          additionalPromptTemplatePaths: options.auxiliary
            ? []
            : (options.pluginResources?.prompts ?? []),
          additionalExtensionPaths: options.auxiliary
            ? []
            : (options.pluginResources?.extensions ?? []),
          noExtensions: options.auxiliary,
          noSkills: options.auxiliary,
          noPromptTemplates: options.auxiliary,
          noThemes: options.auxiliary,
          extensionFactories: [
            createFastModeExtension(fastModeEnabled),
            createCakeArtifactExtension({
              persistArtifact,
              requestArtifact,
              generateInlineWidget: options.generateInlineWidget,
            }),
            ...(options.agentControl
              ? [createAgentControlExtension(options.agentControl, () => runtimeIdentity.sessionId)]
              : []),
            ...(options.reviewContextPath
              ? [reviewContextExtension(options.reviewContextPath, () => runtimeIdentity.sessionId)]
              : []),
            ...(options.auxiliary ? [] : [commandCatalogExtension]),
          ],
        },
  );
  await resourceLoader.reload({ resolveProjectTrust: async () => options.trusted });
  const sessionDir = options.globalControl
    ? resolve(options.sessionDir)
    : cakeWorkspaceSessionDirectory(options.cwd, options.sessionDir);
  const availableSessions = options.newSession
    ? []
    : await SessionManager.list(options.cwd, sessionDir);
  const allowedSessionRoot = sessionDir;
  let directSession: SessionManager | undefined;
  if (options.sessionFile) {
    assertSessionPath(options.sessionFile, allowedSessionRoot, "Session file");
    directSession = SessionManager.open(options.sessionFile, sessionDir, options.cwd);
  }
  const requestedSession = options.sessionId
    ? availableSessions.find((item) => item.id === options.sessionId)
    : undefined;
  if (options.sessionId && !requestedSession && !directSession)
    throw new Error("That session is no longer available");
  const sessionManager = options.newSession
    ? SessionManager.create(options.cwd, sessionDir)
    : (directSession ??
      (requestedSession
        ? SessionManager.open(requestedSession.path, sessionDir, options.cwd)
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
  let rateLimitRetryTurnDepth = 0;
  const rateLimitRetries = new RateLimitRetryController({
    enabled: () => rateLimitRetryTurnDepth > 0 && settingsManager.getRetryEnabled(),
    onRetry: (event) =>
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: {
          id: "active-retry",
          kind: "notice",
          tone: "warning",
          title: `Retry ${event.attempt}/${event.maxAttempts}`,
          detail: retryDelayDetail(event.delayMs, event.errorMessage),
        },
      }),
    onFinished: () =>
      options.onEvent({
        type: "part-removed",
        sessionId: cakeSessionId,
        partId: "active-retry",
      }),
  });
  session.agent.streamFunction = rateLimitRetries.wrap(session.agent.streamFunction);
  async function withRateLimitRetries<T>(operation: () => Promise<T>): Promise<T> {
    rateLimitRetryTurnDepth += 1;
    try {
      return await operation();
    } finally {
      rateLimitRetryTurnDepth -= 1;
    }
  }
  let disposed = false;
  let turnRecoveryFailureDetail: string | undefined;
  let reloadRequested = 0;
  let reloadCompleted = 0;
  let reloadInFlight: Promise<void> | undefined;
  let sessionNamingInFlight = false;
  const sessionNamingController = new AbortController();
  const generateTitle = options.generateSessionTitle ?? generateSessionTitle;
  const projectLiveMessage = createLiveMessageProjector({ deferProviderErrors: true });
  const catalog = compatibilityCatalog(resourceLoader, settingsManager, options.cwd, agentDir);
  const extensionUiState: ExtensionUiState = { statuses: [] };
  const compatibilityDiagnosticKeys = new Set(
    catalog.diagnostics.map((item) => `${item.method ?? ""}:${item.message}`),
  );

  const requestExtensionValue = async (request: RuntimeUiRequest) => options.requestUi(request);
  const extensionUi = createCakeExtensionUiContext({
    request: requestExtensionValue,
    state: extensionUiState,
    emit: (event) => {
      if (!disposed) options.onEvent({ type: "extension-ui", sessionId: cakeSessionId, event });
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
      if (!disposed)
        options.onEvent({
          type: "extension-ui",
          sessionId: cakeSessionId,
          event: { kind: "diagnostic", diagnostic },
        });
    },
  });
  await session.bindExtensions({ mode: "rpc", uiContext: extensionUi });

  async function modelOptions(): Promise<ModelOption[]> {
    const providers = modelRuntime.getProviders();
    const authentication = new Map(
      await Promise.all(
        providers.map(
          async (provider) => [provider.id, await modelRuntime.checkAuth(provider.id)] as const,
        ),
      ),
    );
    return providers.flatMap((provider) =>
      provider
        .getModels()
        .filter((model) => provider.id.length <= 256 && model.id.length <= 512)
        .map((model) => ({
          provider: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          fastMode: supportsFastMode({ provider: provider.id, id: model.id }),
          input: model.input,
          authenticated: Boolean(authentication.get(provider.id)),
          authSource: modelRuntime.getProviderAuthStatus(provider.id).source,
          authLabel:
            authentication.get(provider.id)?.source ??
            modelRuntime.getProviderAuthStatus(provider.id).label,
          authTypes: [
            provider.auth.apiKey ? ("api_key" as const) : undefined,
            provider.auth.oauth ? ("oauth" as const) : undefined,
          ].filter((type): type is "api_key" | "oauth" => Boolean(type)),
        })),
    );
  }

  async function makeSnapshot(): Promise<SessionSnapshot> {
    // Resolve every asynchronous projection first. Pi can continue emitting live
    // events while these are in flight, so reading mutable session state before
    // an await would let an older snapshot overwrite newer renderer deltas.
    const [listedSessions, models, artifacts] = await Promise.all([
      options.auxiliary
        ? Promise.resolve([])
        : listWorkspaceSessions(options.cwd, options.sessionDir, Boolean(options.globalControl)),
      options.auxiliary ? Promise.resolve([]) : modelOptions(),
      options.auxiliary
        ? Promise.resolve([])
        : (options.listArtifacts?.(projectArtifactPointers(session.sessionManager)) ??
          Promise.resolve([])),
    ]);

    // Capture all mutable Pi-owned state together after the final await. Once
    // this synchronous block starts, no live event can interleave before emit.
    const stats = session.getSessionStats();
    const sessionListed = listedSessions.some((item) => item.id === cakeSessionId);
    const sessions = sessionListed
      ? listedSessions
      : [activeSessionSummary(stats.totalMessages), ...listedSessions];
    const globalSettings = settingsManager.getGlobalSettings();
    const branchParts = projectSessionEntries(session.sessionManager.getBranch());
    const queuedParts = allQueuedParts();
    return {
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
            ...getPiCommands(),
          ].flatMap((command) => {
            const parsed = slashCommandSchema.safeParse(command);
            return parsed.success ? [parsed.data] : [];
          }),
      usage: {
        tokens: stats.tokens,
        cost: stats.cost,
        context: stats.contextUsage
          ? {
              tokens: stats.contextUsage.tokens,
              contextWindow: stats.contextUsage.contextWindow,
              percent: stats.contextUsage.percent,
            }
          : undefined,
      },
      compatibility: catalog,
      extensionUi: extensionUiState,
      sessions,
      tree: options.auxiliary ? [] : projectTree(session.sessionManager),
      artifacts,
    };
  }

  function activeSessionSummary(messageCount: number): SessionSnapshot["sessions"][number] {
    const header = session.sessionManager.getHeader();
    const entries = session.sessionManager.getEntries();
    const created = header?.timestamp ?? new Date().toISOString();
    const firstUserMessage = entries
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
    return {
      id: cakeSessionId,
      title: (session.sessionManager.getSessionName() || firstUserMessage || "New chat").slice(
        0,
        SESSION_TITLE_MAX_LENGTH,
      ),
      created,
      modified: entries.at(-1)?.timestamp ?? created,
      messageCount,
      resolved: false,
    };
  }

  async function emitSnapshot(requestId?: string) {
    if (disposed) return;
    const snapshot = await makeSnapshot();
    if (disposed) return;
    options.onEvent({ type: "snapshot", requestId, snapshot });
  }

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
    const utilityModel = options.utilityModel?.();
    if (!utilityModel) return;
    const firstUserMessage = session.sessionManager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
      .filter((message) => message.role === "user")
      .map((message) => textFromContent(message.content).trim())
      .find(Boolean);
    const userText = firstUserMessage || currentUserMessage.trim();
    if (!userText) return;

    sessionNamingInFlight = true;
    try {
      const title = await generateTitle({
        modelRuntime,
        utilityModel,
        firstUserMessage: userText,
        signal: AbortSignal.any([sessionNamingController.signal, AbortSignal.timeout(15_000)]),
      });
      if (disposed || !title || session.sessionManager.getSessionName()) return;
      session.setSessionName(title);
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
    text: string;
    attachments: Attachment[];
    delivery: "steer" | "follow-up";
  }[] = [];
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
  // Pi owns provider-error retries. Cake only handles response shapes Pi sees
  // as successful/aborted but that contain no completed response. The fallback
  // is hidden, obeys Pi's retry setting, and is bounded to one continuation.
  let userAbortRequested = false;
  let turnRecoveryContinuations = 0;

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
      await withRateLimitRetries(() =>
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
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (disposed) return;
    if (event.type === "agent_start") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: true });
    }
    for (const part of projectLiveMessage(event)) {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
    }
    if (event.type === "tool_execution_start") {
      const call = {
        input: formatToolInput(event.toolName, event.args),
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
        part: {
          id: "active-retry",
          kind: "notice",
          tone: "warning",
          title: `Retry ${event.attempt}/${event.maxAttempts}`,
          detail: retryDelayDetail(event.delayMs, event.errorMessage),
        },
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
    if (!options.auxiliary && event.type === "message_end" && event.message.role === "user") {
      // The user message is not appended to SessionManager until after subscribers run, so
      // pass the event payload while still using the active branch for reopened sessions.
      void nameSessionFromFirstMessage(textFromContent(event.message.content));
    }
    if (event.type === "agent_settled") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: false });
      void drainReloads()
        .catch(() => undefined)
        .finally(() => {
          // Apply recovery only after the settled snapshot so its transient
          // failure notice cannot be overwritten by that snapshot.
          void emitSnapshot()
            .catch(() => undefined)
            .finally(handleSettledTurnRecovery);
        });
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
            await withRateLimitRetries(() =>
              session.prompt(content, { images, source: "interactive" }),
            );
            continue;
          } catch (error) {
            // A turn may have started between the check and this call.
            if (!isAlreadyProcessingError(error)) throw error;
          }
        }
        if (item.delivery === "steer") await session.steer(content, images);
        else await session.followUp(content, images);
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

  return {
    sessionId: cakeSessionId,
    get sessionFile() {
      return session.sessionFile ?? "";
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
      const parsed = reviewRunEntrySchema.parse(run);
      session.sessionManager.appendCustomEntry(reviewRunEntryType, parsed);
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: reviewRunPart(parsed),
      });
    },
    snapshot: makeSnapshot,
    compact: (instructions) => runCompact(instructions),
    async prompt(text, delivery, attachments) {
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
      if (!session.isStreaming && reloadCompleted < reloadRequested) await drainReloads();
      if (session.isCompacting) {
        // Pi rejects prompts during compaction. Hold the message with its
        // delivery intent and deliver it when compaction finishes instead of
        // failing the submission.
        compactionQueue.push({
          text,
          attachments,
          // A plain "prompt" intent degrades to a follow-up when it has to
          // wait behind compaction; steering intent is preserved.
          delivery: delivery === "steer" ? "steer" : "follow-up",
        });
        syncQueuedParts();
        return;
      }
      const content = promptText(text, attachments);
      const images = imageContent(attachments);
      if (delivery === "steer") await session.steer(content, images);
      else if (delivery === "follow-up") await session.followUp(content, images);
      else if (session.isStreaming) {
        // The renderer may see a stale idle snapshot while a turn is still
        // running. Queue the message instead of failing the submission.
        await session.followUp(content, images);
      } else {
        try {
          await withRateLimitRetries(() =>
            session.prompt(content, { images, source: "interactive" }),
          );
        } catch (error) {
          // The turn may have started between the check and this call.
          if (!isAlreadyProcessingError(error)) throw error;
          await session.followUp(content, images);
        }
      }
    },
    abort: () => {
      userAbortRequested = true;
      turnRecoveryContinuations = 0;
      removeRecoveryNotice();
      rateLimitRetries.cancel();
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
    async setFastMode(enabled) {
      if (enabled && !supportsFastMode(session.model))
        throw new Error("Fast mode is unavailable for the current model");
      if (options.fastMode) await options.fastMode.set(enabled);
      fastMode = enabled;
      await emitSnapshot();
    },
    async syncFastMode() {
      if (options.fastMode) fastMode = options.fastMode.get();
      await emitSnapshot();
    },
    async setPiSetting(update) {
      applyPiSetting(settingsManager, session, update);
      if (update.key === "retryEnabled" && !update.value) rateLimitRetries.cancel();
      await settingsManager.flush();
      await emitSnapshot();
    },
    reload: requestReload,
    async refreshModels() {
      options.onEvent({
        type: "part-updated",
        sessionId: cakeSessionId,
        part: {
          id: "pi-models-status",
          kind: "notice",
          tone: "info",
          title: "Refreshing models",
          detail: "Fetching the latest model catalog from providers.",
        },
      });
      try {
        await modelRuntime.refresh({ allowNetwork: true, force: true });
        if (!disposed) {
          options.onEvent({
            type: "part-removed",
            sessionId: cakeSessionId,
            partId: "pi-models-status",
          });
        }
      } catch (error) {
        if (!disposed) {
          options.onEvent({
            type: "part-updated",
            sessionId: cakeSessionId,
            part: {
              id: "pi-models-status",
              kind: "notice",
              tone: "error",
              title: "Model refresh failed",
              detail: error instanceof Error ? error.message : String(error),
            },
          });
        }
        throw error;
      } finally {
        await emitSnapshot();
      }
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
      session.setSessionName(name.trim());
      await emitSnapshot();
    },
    async fork(entryId) {
      const sessionFile = session.sessionManager.createBranchedSession(entryId);
      if (!sessionFile) throw new Error("The current session is not persisted");
      const forked = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
      return { sessionId: forked.getSessionId(), sessionFile };
    },
    async navigate(entryId) {
      const result = await session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("Session tree navigation was cancelled");
      await emitSnapshot();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sessionNamingController.abort();
      rateLimitRetries.cancel();
      unsubscribe();
      const finish = () => {
        session.dispose();
        void settingsManager.flush();
      };
      // Graceful teardown: while a run is active, abort first so Pi unwinds
      // through its normal failure path and persists the "aborted" marker.
      // Disposing immediately would kill the request silently and leave the
      // session ending in dangling tool results with no trace of the stop.
      if (session.isStreaming) {
        void session
          .abort()
          .catch(() => undefined)
          .then(finish, finish);
        return;
      }
      finish();
    },
  };
}
