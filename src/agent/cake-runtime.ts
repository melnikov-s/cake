import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent,
  type InlineExtension,
  type SlashCommandInfo
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
  UiPart,
  UtilityModel
} from "../ipc/session-contract";
import { piBuiltinSlashCommands, slashCommandSchema } from "../ipc/session-contract";
import { jsonValueSchema, type JsonObject, type JsonValue } from "../ipc/json-contract";
import { agentModelPreferenceSchema } from "../ipc/plugin-agent-contract";
import { artifactRecordSchema, type ArtifactRecord, type ArtifactPointer, type CakeArtifactV1 } from "../ipc/artifact-contract";
import type { TSchema } from "@earendil-works/pi-ai";
import { createCakeArtifactExtension } from "./artifact-extension";
import { compatibilityCatalog, createCakeExtensionUiContext } from "./extension-compatibility";
import type { InlineWidgetGenerationRequest, InlineWidgetGenerationResult, ReviewParentContext } from "./sidecar-runtime";
import { assertSessionPath } from "./session-path";
import { applyPiSetting } from "./settings-translation";
import { cakePluginAuthoringSkillPath, cakeWorkspaceSessionDirectory, listWorkspaceSessions } from "./session-discovery";
import { generateSessionTitle } from "./utility-model";
import {
  boundedProjectionKey,
  createLiveMessageProjector,
  formatToolInput,
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
  toolResultDiff,
  type ReviewRunEntry
} from "./session-projection";

export const piRuntimeVersion = "0.84.0" as const;
const cakeProjectSystemPrompt = `## Cake desktop environment

You are running inside Cake, a desktop interface powered by Pi. Your messages, tool activity, and rich outputs are rendered in Cake rather than Pi's terminal UI. Keep the conversation as the primary interface and continue using Pi's tools, skills, extensions, project context, and session behavior normally. Do not direct the user to terminal-only UI controls.

Cake streams GitHub-flavored Markdown, syntax-highlighted code blocks, mathematical notation, and Mermaid diagrams directly in the transcript. Prefer these inline formats when they communicate the result clearly. Do not use an artifact merely to style content that Markdown, tables, code blocks, math, or Mermaid can express.

For standalone deliverables such as PowerPoint presentations, PDFs, spreadsheets, documents, images, audio, or video, use the available Pi tools and skills and link the resulting workspace file in Markdown. Do not recreate a file deliverable as decorative HTML.

Cake can delegate one-off visual explanations to a separate widget agent. Use ui_widget when an interactive or highly visual presentation materially improves the explanation and Markdown, a table, or Mermaid is insufficient. Provide a self-contained presentation brief, all required data, and a readable Markdown fallback; do not write React or HTML yourself. Cake generates and stores the implementation outside this conversation context, then renders the sandboxed widget at the tool-call position. Prefer ordinary transcript content for simple or primarily textual explanations.

Use ui_request only when the running turn must block and receive validated user input. Pass one cake.request/v1 request with a unique ID, a responseSchema, a readable Markdown fallback, and either a form view or a widget view. Prefer the form view for ordinary fields. Use a widget view only for a genuinely visual interaction; HTML widget source calls cakeRequest.submit(value) or cakeRequest.cancel(), while a React widget component receives { submit, cancel } props. Custom request widgets have the same isolation as inline widgets. Do not call ui_request for content that can be presented in the assistant message.

When referencing workspace files, use Markdown links with absolute paths so Cake can open them.`;
const gitCheckpointEntryType = "cake.git-checkpoint/v1";
const gitCheckpointSchema = z.object({
  tree: z.string().regex(/^[0-9a-f]{40,64}$/),
  ref: z.string().min(1).max(1_024),
  capturedAt: z.string().datetime()
});
export type GitCheckpoint = z.infer<typeof gitCheckpointSchema>;

export interface GitChangeTurn {
  id: string;
  label: string;
  capturedAt: string;
  beforeTree: string;
  afterTree: string;
}

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
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  persistArtifact?(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact?(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(input: InlineWidgetGenerationRequest): Promise<InlineWidgetGenerationResult>;
  listArtifacts?(pointers: ArtifactPointer[]): Promise<ArtifactRecord[]>;
  openExternal?(url: string): Promise<void>;
  captureGitCheckpoint?(sessionId: string): Promise<{ tree: string; ref: string }>;
  reviewContextPath?(sessionId: string): string;
  utilityModel?(): UtilityModel | undefined;
  generateSessionTitle?: typeof generateSessionTitle;
  globalControl?: {
    tools: readonly GlobalControlTool[];
    recoveryContext?: string;
    invoke(input: { name: string; arguments: JsonValue }, signal: AbortSignal): Promise<JsonValue>;
  };
  agentControl?: {
    open(input: { target: "new" | "attach" | "fork"; sessionId?: string; entryId?: string; visibility: "private" | "project"; model: z.infer<typeof agentModelPreferenceSchema>; instructions?: string }, parentSessionId: string, signal: AbortSignal): Promise<JsonValue>;
    prompt(input: { handleId: string; text: string; delivery: "prompt" | "follow-up" }, parentSessionId: string, signal: AbortSignal): Promise<JsonValue>;
    wait(handleId: string, parentSessionId: string, signal: AbortSignal): Promise<JsonValue>;
    abort(handleId: string, parentSessionId: string): Promise<JsonValue>;
  };
  onEvent(event: CakeRuntimeEvent): void;
}

export interface GlobalControlTool {
  name: string;
  description: string;
  parameters: JsonObject;
}

function createGlobalControlExtension(control: NonNullable<CakeRuntimeOptions["globalControl"]>): InlineExtension {
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
          const result = await control.invoke({ name: tool.name, arguments: jsonValueSchema.parse(params) }, signal ?? new AbortController().signal);
          return { content: [{ type: "text", text: formatUnknown(result, 24_000) }], details: result };
        }
      });
    }
  };
}

function createAgentControlExtension(control: NonNullable<CakeRuntimeOptions["agentControl"]>, parentSessionId: () => string | undefined): InlineExtension {
  const openSchema = z.object({
    target: z.enum(["new", "attach", "fork"]),
    sessionId: z.string().min(1).max(256).optional(),
    entryId: z.string().min(1).max(256).optional(),
    visibility: z.enum(["private", "project"]).default("private"),
    model: agentModelPreferenceSchema.default({ prefer: "current" }),
    instructions: z.string().max(32_768).optional()
  });
  const promptSchema = z.object({ handleId: z.uuid(), text: z.string().min(1).max(262_144) });
  const handleSchema = z.object({ handleId: z.uuid() });
  const tools = [
    { name: "agent_open", description: "Create, attach to, or fork a coordinated Cake Pi agent session.", schema: openSchema, run: (value: z.infer<typeof openSchema>, parent: string, signal: AbortSignal) => control.open(value, parent, signal) },
    { name: "agent_prompt", description: "Send a normal prompt to an idle child agent and wait for its turn.", schema: promptSchema, run: (value: z.infer<typeof promptSchema>, parent: string, signal: AbortSignal) => control.prompt({ ...value, delivery: "prompt" }, parent, signal) },
    { name: "agent_follow_up", description: "Queue a follow-up for a child agent using Pi's normal queue policy.", schema: promptSchema, run: (value: z.infer<typeof promptSchema>, parent: string, signal: AbortSignal) => control.prompt({ ...value, delivery: "follow-up" }, parent, signal) },
    { name: "agent_wait", description: "Read the latest state of a child agent.", schema: handleSchema, run: (value: z.infer<typeof handleSchema>, parent: string, signal: AbortSignal) => control.wait(value.handleId, parent, signal) },
    { name: "agent_abort", description: "Abort active work in a child agent.", schema: handleSchema, run: (value: z.infer<typeof handleSchema>, parent: string) => control.abort(value.handleId, parent) }
  ];
  return (pi) => {
    for (const tool of tools) pi.registerTool({
      name: tool.name,
      label: tool.name.replaceAll("_", " "),
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema) as TSchema,
      async execute(_toolCallId, params, signal) {
        const parent = parentSessionId();
        if (!parent) throw new Error("The parent Cake session is not ready");
        const result = await tool.run(tool.schema.parse(params) as never, parent, signal ?? new AbortController().signal);
        return { content: [{ type: "text", text: formatUnknown(result, 24_000) }], details: result };
      }
    });
  };
}

function reviewContextExtension(pathForSession: (sessionId: string) => string, sessionId: () => string | undefined): InlineExtension {
  return (pi) => {
    pi.on("before_agent_start", () => {
      const id = sessionId();
      if (!id) return;
      const path = pathForSession(id);
      if (!existsSync(path)) return;
      return { message: { customType: "cake.review-context", display: false, content: `Inline code reviews and assistant-message discussions for this session are indexed at ${path}. Read or search that file when the user asks you to incorporate, summarize, or reason about those threads; otherwise leave it alone.` } };
    });
  };
}

export interface CakeRuntime {
  readonly sessionId: string;
  readonly sessionFile: string;
  getReviewParentContext?(): ReviewParentContext;
  recordReviewRun(run: ReviewRunEntry): void;
  snapshot(requestId?: string): Promise<SessionSnapshot>;
  prompt(text: string, delivery: "prompt" | "steer" | "follow-up", attachments: Attachment[]): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setPiSetting(update: PiSettingUpdate): Promise<void>;
  reload?(): Promise<void>;
  login(provider: string, authType: "api_key" | "oauth"): Promise<void>;
  logout(provider: string): Promise<void>;
  rename(name: string): Promise<void>;
  fork(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  navigate(entryId: string): Promise<void>;
  ensureInitialGitCheckpoint?(): Promise<GitCheckpoint | undefined>;
  captureLatestGitCheckpoint?(): Promise<GitCheckpoint | undefined>;
  waitForGitCheckpoints?(): Promise<void>;
  gitCheckpoints?(): GitCheckpoint[];
  gitChangeTurns?(): GitChangeTurn[];
  dispose(): void;
}


export async function createCakeRuntime(options: CakeRuntimeOptions): Promise<CakeRuntime> {
  const agentDir = options.agentDir;
  const settingsManager = SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.trusted });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`
  });
  const persistArtifact = options.persistArtifact ?? (async (artifact: CakeArtifactV1) => artifactRecordSchema.parse({ artifact, workspacePath: options.cwd, digest: "0".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const requestArtifact = options.requestArtifact ?? (async () => undefined);
  let getPiCommands: () => SlashCommandInfo[] = () => [];
  interface RuntimeIdentity { sessionId?: string }
  const runtimeIdentity: RuntimeIdentity = {};
  const commandCatalogExtension: InlineExtension = (pi) => { getPiCommands = () => pi.getCommands(); };
  const resourceLoader = new DefaultResourceLoader(options.globalControl ? {
    cwd: options.cwd,
    agentDir,
    settingsManager,
    extensionFactories: [createGlobalControlExtension(options.globalControl), commandCatalogExtension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: `You are Cake Chat, Cake's application assistant. Help the user find, understand, navigate, and control their Cake sessions. Use the provided application tools instead of filesystem or shell tools. Earlier messages are part of the conversation; resolve follow-up references from them. Refresh live application state with tools when it may have changed. Never claim an action succeeded unless its tool result says it did.

For Cake customizations, choose the execution path deliberately: deterministic network, filesystem, Git, Bash, and subprocess work belongs in an unrestricted plugin backend; bounded summaries, classification, and extraction belong in usePluginCompletion; open-ended multi-turn tool work belongs in usePluginAgent. Delegated inline widgets never receive these trusted capabilities.

When the user asks you to create or change a Cake plugin, widget, scene, or other customization, that request authorizes the complete authoring loop. First call get_plugin_authoring_reference; it is the exact API for this Cake version, so never use compiler errors or speculative writes to discover the API. Inspect customization state and plugin files, create or edit plugin-owned source, validate it, and inspect every diagnostic. Ordinary widgets are renderer plugins and must not create or select a scene. A plugin scene is only for an explicit request to replace the whole application scene. Slot namespaces are ownership boundaries: global.* is application chrome across Cake Chat, project sessions, and settings, while project-session.* exists only inside a selected project session. project-session.header.actions is the toolbar/menu row. Persistent session panels use the normal-flow project-session.left.top, project-session.left.middle, project-session.left.bottom, project-session.right.top, project-session.right.middle, and project-session.right.bottom rails; "top right of the session" means project-session.right.top. Rail contributions reserve space and must not position themselves over the conversation. Header slots are fixed-height action rows; contribute a compact trigger there. When temporary UI should intentionally overlap, use Cake's Popover, PopoverTrigger, and PopoverContent instead of plugin-owned absolute or fixed positioning. A failed typecheck or bundle is intermediate authoring feedback: fix the source and validate again autonomously. Validation never changes the running UI. Call activate_customization only after the requested implementation is complete and validation succeeds. Do not stop to report ordinary authoring diagnostics or ask whether the user wants you to fix them. Treat responsive, collision-free layout as an authoring acceptance criterion: custom scenes and widgets must reflow without overlapping text, controls, icons, navigation, or Cake-owned children from 320 CSS pixels through wide desktop sizes and with long labels or values. Use normal-flow flex or grid layout that wraps, reserve space for icons and decorations, and avoid absolute or fixed positioning for structural content. Stop only when the customization succeeds or you are genuinely blocked by missing user intent, unavailable capability, or a conflict you cannot safely resolve. A failure reported for a previously activated customization is a recovery event that you may surface before the user requests repair; once they ask for repair, carry that repair through the same autonomous edit-validate-activate loop.${options.globalControl.recoveryContext ? `\n\nCustomization recovery context from immutable Cake core:\n${options.globalControl.recoveryContext}` : ""}`
  } : {
    cwd: options.cwd,
    agentDir,
    settingsManager,
    appendSystemPromptOverride: (base) => [...base, cakeProjectSystemPrompt, ...(options.additionalSystemPrompt ? [options.additionalSystemPrompt] : [])],
    additionalSkillPaths: [cakePluginAuthoringSkillPath(), ...(options.pluginResources?.skills ?? [])],
    additionalPromptTemplatePaths: options.pluginResources?.prompts ?? [],
    additionalExtensionPaths: options.pluginResources?.extensions ?? [],
    extensionFactories: [
      createCakeArtifactExtension({ persistArtifact, requestArtifact, generateInlineWidget: options.generateInlineWidget }),
      ...(options.agentControl ? [createAgentControlExtension(options.agentControl, () => runtimeIdentity.sessionId)] : []),
      ...(options.reviewContextPath ? [reviewContextExtension(options.reviewContextPath, () => runtimeIdentity.sessionId)] : []),
      commandCatalogExtension
    ]
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.trusted });
  const sessionDir = options.globalControl
    ? resolve(options.sessionDir)
    : cakeWorkspaceSessionDirectory(options.cwd, options.sessionDir);
  const availableSessions = await SessionManager.list(options.cwd, sessionDir);
  const allowedSessionRoot = sessionDir;
  let directSession: SessionManager | undefined;
  if (options.sessionFile) {
    assertSessionPath(options.sessionFile, allowedSessionRoot, "Session file");
    directSession = SessionManager.open(options.sessionFile, sessionDir, options.cwd);
  }
  const requestedSession = options.sessionId
    ? availableSessions.find((item) => item.id === options.sessionId)
    : undefined;
  if (options.sessionId && !requestedSession && !directSession) throw new Error("That session is no longer available");
  const sessionManager = options.newSession
    ? SessionManager.create(options.cwd, sessionDir)
    : directSession ?? (requestedSession
      ? SessionManager.open(requestedSession.path, sessionDir, options.cwd)
      : SessionManager.continueRecent(options.cwd, sessionDir));
  const agentSessionOptions = {
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
  };
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(
    options.globalControl
      ? { ...agentSessionOptions, noTools: "builtin" as const }
      : agentSessionOptions,
  );
  const cakeSessionId = session.sessionManager.getSessionId();
  runtimeIdentity.sessionId = cakeSessionId;
  let disposed = false;
  let checkpointQueue = Promise.resolve<unknown>(undefined);
  let reloadRequested = 0;
  let reloadCompleted = 0;
  let reloadInFlight: Promise<void> | undefined;
  let sessionNamingInFlight = false;
  const sessionNamingController = new AbortController();
  const generateTitle = options.generateSessionTitle ?? generateSessionTitle;
  const projectLiveMessage = createLiveMessageProjector();
  const catalog = compatibilityCatalog(resourceLoader, settingsManager, options.cwd, agentDir);
  const extensionUiState: ExtensionUiState = { statuses: [] };
  const compatibilityDiagnosticKeys = new Set(catalog.diagnostics.map((item) => `${item.method ?? ""}:${item.message}`));

  const requestExtensionValue = async (request: RuntimeUiRequest) => options.requestUi(request);
  const extensionUi = createCakeExtensionUiContext({
    request: requestExtensionValue,
    state: extensionUiState,
    emit: (event) => { if (!disposed) options.onEvent({ type: "extension-ui", sessionId: cakeSessionId, event }); },
    addDiagnostic(method, message) {
      const key = `${method}:${message}`;
      if (compatibilityDiagnosticKeys.has(key)) return;
      compatibilityDiagnosticKeys.add(key);
      const diagnostic: ResourceDiagnostic = { id: `compatibility:${method}:${compatibilityDiagnosticKeys.size}`, severity: "warning", source: "compatibility", method, message };
      catalog.diagnostics.push(diagnostic);
      if (!disposed) options.onEvent({ type: "extension-ui", sessionId: cakeSessionId, event: { kind: "diagnostic", diagnostic } });
    }
  });
  await session.bindExtensions({ mode: "rpc", uiContext: extensionUi });

  async function modelOptions(): Promise<ModelOption[]> {
    const providers = modelRuntime.getProviders();
    const authentication = new Map(await Promise.all(providers.map(async (provider) => [provider.id, await modelRuntime.checkAuth(provider.id)] as const)));
    return providers.flatMap((provider) => provider.getModels()
      .filter((model) => provider.id.length <= 256 && model.id.length <= 512)
      .map((model) => ({
      provider: provider.id,
      providerName: provider.name,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      authenticated: Boolean(authentication.get(provider.id)),
      authSource: modelRuntime.getProviderAuthStatus(provider.id).source,
      authLabel: authentication.get(provider.id)?.source ?? modelRuntime.getProviderAuthStatus(provider.id).label,
      authTypes: [provider.auth.apiKey ? "api_key" as const : undefined, provider.auth.oauth ? "oauth" as const : undefined].filter((type): type is "api_key" | "oauth" => Boolean(type))
      })));
  }

  async function makeSnapshot(): Promise<SessionSnapshot> {
    const sessions = await listWorkspaceSessions(options.cwd, options.sessionDir, Boolean(options.globalControl));
    const stats = session.getSessionStats();
    const globalSettings = settingsManager.getGlobalSettings();
    const branchParts = projectSessionEntries(session.sessionManager.getBranch());
    const queuedParts = projectQueuedMessages(session.getSteeringMessages(), session.getFollowUpMessages());
    return {
      workspacePath: options.cwd,
      sessionId: cakeSessionId,
      sessionFile: session.sessionFile ?? "",
      parts: [...branchParts, ...queuedParts],
      model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : undefined,
      models: await modelOptions(),
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
        reloadPending: reloadCompleted < reloadRequested || Boolean(reloadInFlight)
      } satisfies PiSettings,
      streaming: session.isStreaming,
      diagnostics: [
        ...extensionsResult.errors.map((error) => `${error.path}: ${error.error}`),
        ...(modelFallbackMessage ? [modelFallbackMessage] : [])
      ],
      commands: [...piBuiltinSlashCommands, ...getPiCommands()].flatMap((command) => {
        const parsed = slashCommandSchema.safeParse(command);
        return parsed.success ? [parsed.data] : [];
      }),
      usage: {
        tokens: stats.tokens,
        cost: stats.cost,
        context: stats.contextUsage ? {
          tokens: stats.contextUsage.tokens,
          contextWindow: stats.contextUsage.contextWindow,
          percent: stats.contextUsage.percent
        } : undefined
      },
      compatibility: catalog,
      extensionUi: extensionUiState,
      sessions,
      tree: projectTree(session.sessionManager),
      artifacts: await (options.listArtifacts?.(projectArtifactPointers(session.sessionManager)) ?? Promise.resolve([]))
    };
  }

  async function emitSnapshot(requestId?: string) {
    if (disposed) return;
    const snapshot = await makeSnapshot();
    if (disposed) return;
    options.onEvent({ type: "snapshot", requestId, snapshot });
  }

  async function drainReloads() {
    if (reloadInFlight) return reloadInFlight;
    if (reloadCompleted >= reloadRequested || session.isStreaming || session.isCompacting) return;
    reloadInFlight = (async () => {
      try {
        while (!disposed && reloadCompleted < reloadRequested && !session.isStreaming && !session.isCompacting) {
          const target = reloadRequested;
          options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "pi-reload-status", kind: "notice", tone: "info", title: "Reloading Pi", detail: "Refreshing settings, extensions, skills, prompts, and tools." } });
          await session.reload();
          reloadCompleted = target;
        }
        if (!disposed && reloadCompleted >= reloadRequested) options.onEvent({ type: "part-removed", sessionId: cakeSessionId, partId: "pi-reload-status" });
      } catch (error) {
        reloadCompleted = reloadRequested;
        if (!disposed) options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "pi-reload-status", kind: "notice", tone: "error", title: "Pi reload failed", detail: error instanceof Error ? error.message : String(error) } });
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
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "pi-reload-status", kind: "notice", tone: "info", title: "Pi reload queued", detail: "Cake will reload Pi after the current response settles." } });
      await emitSnapshot();
      return;
    }
    await drainReloads();
  }

  async function nameSessionFromFirstExchange() {
    if (disposed || sessionNamingInFlight || session.sessionManager.getSessionName()) return;
    const utilityModel = options.utilityModel?.();
    if (!utilityModel) return;
    const messages = session.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => textFromContent(message.content).trim())
      .find(Boolean);
    const assistantText = messages
      .filter((message) => message.role === "assistant")
      .map((message) => textFromContent(message.content).trim())
      .find(Boolean);
    if (!userText || !assistantText) return;

    sessionNamingInFlight = true;
    try {
      const title = await generateTitle({
        modelRuntime,
        utilityModel,
        firstUserMessage: userText,
        firstAssistantMessage: assistantText,
        signal: AbortSignal.any([sessionNamingController.signal, AbortSignal.timeout(15_000)])
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

  function gitCheckpoints() {
    const checkpoints: GitCheckpoint[] = [];
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== gitCheckpointEntryType) continue;
      const parsed = gitCheckpointSchema.safeParse(entry.data);
      if (parsed.success) checkpoints.push(parsed.data);
    }
    return checkpoints;
  }

  function gitChangeTurns(): GitChangeTurn[] {
    const turns: GitChangeTurn[] = [];
    let previous: GitCheckpoint | undefined;
    let userLabel = "Agent changes";
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "user") {
        const text = textFromContent(entry.message.content).replace(/\s+/g, " ").trim();
        userLabel = text ? text.slice(0, 1_024) : "User turn";
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== gitCheckpointEntryType) continue;
      const parsed = gitCheckpointSchema.safeParse(entry.data);
      if (!parsed.success) continue;
      const checkpoint = parsed.data;
      if (previous && previous.tree !== checkpoint.tree) {
        turns.push({
          id: entry.id,
          label: userLabel,
          capturedAt: checkpoint.capturedAt,
          beforeTree: previous.tree,
          afterTree: checkpoint.tree
        });
      }
      previous = checkpoint;
    }
    return turns;
  }

  function captureGitCheckpoint() {
    if (!options.captureGitCheckpoint) return Promise.resolve(undefined);
    const operation = checkpointQueue.then(async () => {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const captured = await options.captureGitCheckpoint!(cakeSessionId);
      const checkpoint = gitCheckpointSchema.parse({ ...captured, capturedAt: new Date().toISOString() });
      const latest = gitCheckpoints().at(-1);
      if (latest?.tree === checkpoint.tree) return latest;
      session.sessionManager.appendCustomEntry(gitCheckpointEntryType, checkpoint);
      return checkpoint;
    });
    checkpointQueue = operation.catch(() => undefined);
    return operation;
  }

  async function ensureInitialGitCheckpoint() {
    const persisted = session.sessionManager.getEntries().flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== gitCheckpointEntryType) return [];
      const parsed = gitCheckpointSchema.safeParse(entry.data);
      return parsed.success ? [parsed.data] : [];
    });
    return persisted[0] ?? await captureGitCheckpoint();
  }

  const activeToolCalls = new Map<string, { input: string; artifactId?: string; filePath?: string }>();
  let queuedPartIds = new Set(projectQueuedMessages(session.getSteeringMessages(), session.getFollowUpMessages()).map((part) => part.id));
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (disposed) return;
    if (event.type === "agent_start") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: true });
    }
    for (const part of projectLiveMessage(event)) {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
    }
    if (event.type === "tool_execution_start") {
      const call = { input: formatToolInput(event.toolName, event.args), artifactId: toolArtifactId(event.args), filePath: toolFilePath(event.toolName, event.args) };
      activeToolCalls.set(event.toolCallId, call);
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: boundedProjectionKey(`tool-${event.toolCallId}`), kind: "tool", name: event.toolName, ...call, state: "running" } });
    }
    if (event.type === "tool_execution_update") {
      const call = activeToolCalls.get(event.toolCallId) ?? { input: formatToolInput(event.toolName, event.args), artifactId: toolArtifactId(event.args), filePath: toolFilePath(event.toolName, event.args) };
      activeToolCalls.set(event.toolCallId, call);
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: boundedProjectionKey(`tool-${event.toolCallId}`), kind: "tool", name: event.toolName, ...call, output: formatUnknown(event.partialResult), state: "running" } });
    }
    if (event.type === "tool_execution_end") {
      const call = activeToolCalls.get(event.toolCallId);
      activeToolCalls.delete(event.toolCallId);
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: boundedProjectionKey(`tool-${event.toolCallId}`), kind: "tool", name: event.toolName, input: call?.input ?? "", output: formatUnknown(event.result), artifactId: toolArtifactId(event.result) ?? call?.artifactId, filePath: call?.filePath, diff: toolResultDiff(event.toolName, event.result), state: event.isError ? "error" : "success" } });
    }
    if (event.type === "auto_retry_start") {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "active-retry", kind: "notice", tone: "warning", title: `Retry ${event.attempt}/${event.maxAttempts}`, detail: event.errorMessage } });
    }
    if (event.type === "compaction_start") {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "active-compaction", kind: "notice", tone: "info", title: "Compacting context", detail: event.reason } });
    }
    if (event.type === "compaction_end") {
      if (event.aborted) {
        options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "active-compaction", kind: "notice", tone: "warning", title: "Compaction cancelled", detail: event.errorMessage } });
      } else if (event.errorMessage) {
        options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "active-compaction", kind: "notice", tone: "error", title: "Compaction failed", detail: event.errorMessage } });
      } else {
        options.onEvent({ type: "part-removed", sessionId: cakeSessionId, partId: "active-compaction" });
        void emitSnapshot();
      }
    }
    if (event.type === "queue_update") {
      const queuedParts = projectQueuedMessages(event.steering, event.followUp);
      const nextIds = new Set(queuedParts.map((part) => part.id));
      for (const partId of queuedPartIds) {
        if (!nextIds.has(partId)) options.onEvent({ type: "part-removed", sessionId: cakeSessionId, partId });
      }
      for (const part of queuedParts) options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
      queuedPartIds = nextIds;
    }
    if (event.type === "agent_settled") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: false });
      void nameSessionFromFirstExchange();
      void captureGitCheckpoint().catch(() => undefined).then(() => drainReloads()).catch(() => undefined).finally(() => emitSnapshot());
    }
  });

  return {
    sessionId: cakeSessionId,
    get sessionFile() { return session.sessionFile ?? ""; },
    getReviewParentContext() {
      if (!session.sessionFile) throw new Error("The parent session is not persisted");
      const leafId = session.sessionManager.getLeafId() ?? undefined;
      return {
        sessionId: cakeSessionId,
        sessionFile: session.sessionFile,
        leafId,
        systemPrompt: session.systemPrompt,
        activeTools: session.getActiveToolNames(),
        model: session.model ? { provider: session.model.provider, id: session.model.id } : undefined
      };
    },
    recordReviewRun(run) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const parsed = reviewRunEntrySchema.parse(run);
      session.sessionManager.appendCustomEntry(reviewRunEntryType, parsed);
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: reviewRunPart(parsed) });
    },
    snapshot: makeSnapshot,
    async prompt(text, delivery, attachments) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      if (!session.isStreaming && reloadCompleted < reloadRequested) await drainReloads();
      const content = promptText(text, attachments);
      const images = imageContent(attachments);
      if (delivery === "steer") await session.steer(content, images);
      else if (delivery === "follow-up") await session.followUp(content, images);
      else await session.prompt(content, { images, source: "interactive" });
    },
    abort: () => session.abort(),
    async setModel(provider, modelId) {
      const model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
      await session.setModel(model);
      await emitSnapshot();
    },
    async setThinkingLevel(level) {
      session.setThinkingLevel(level);
      await emitSnapshot();
    },
    async setPiSetting(update) {
      applyPiSetting(settingsManager, session, update);
      await settingsManager.flush();
      await emitSnapshot();
    },
    reload: requestReload,
    async login(provider, authType) {
      await modelRuntime.login(provider, authType, {
        async prompt(prompt) {
          const value = await requestExtensionValue({
            kind: prompt.type,
            title: "Provider authentication",
            message: prompt.message,
            placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
            options: prompt.type === "select" ? prompt.options.map((option) => ({ id: option.id, label: option.label })) : undefined,
            signal: prompt.signal
          });
          if (value === undefined) throw new Error("Authentication cancelled");
          return value;
        },
        notify(event) {
          const detail = event.type === "auth_url" ? event.url : event.type === "device_code" ? `${event.verificationUri}\nCode: ${event.userCode}` : event.message;
          options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "auth-status", kind: "notice", tone: "info", title: "Authentication", detail } });
          const url = event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : undefined;
          if (url && options.openExternal) {
            void options.openExternal(url).catch((error) => {
              options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "auth-status", kind: "notice", tone: "error", title: "Could not open authentication", detail: `${error instanceof Error ? error.message : String(error)}\n${detail}` } });
            });
          }
        }
      });
      await emitSnapshot();
    },
    async logout(provider) {
      const status = modelRuntime.getProviderAuthStatus(provider);
      if (status.configured && status.source && status.source !== "stored" && status.source !== "runtime") {
        throw new Error(`${status.label ?? provider} is managed outside Cake. Remove that credential source and restart Cake to disconnect it.`);
      }
      await modelRuntime.logout(provider);
      await emitSnapshot();
    },
    async rename(name) {
      session.setSessionName(name.trim());
      await emitSnapshot();
    },
    async fork(entryId) {
      const initialCheckpoint = session.sessionManager.getEntries().flatMap((entry) => {
        if (entry.type !== "custom" || entry.customType !== gitCheckpointEntryType) return [];
        const parsed = gitCheckpointSchema.safeParse(entry.data);
        return parsed.success ? [parsed.data] : [];
      })[0];
      const sessionFile = session.sessionManager.createBranchedSession(entryId);
      if (!sessionFile) throw new Error("The current session is not persisted");
      const forked = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
      const forkHasCheckpoint = forked.getEntries().some((entry) => entry.type === "custom" && entry.customType === gitCheckpointEntryType);
      if (initialCheckpoint && !forkHasCheckpoint) forked.appendCustomEntry(gitCheckpointEntryType, initialCheckpoint);
      return { sessionId: forked.getSessionId(), sessionFile };
    },
    async navigate(entryId) {
      const result = await session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("Session tree navigation was cancelled");
      await emitSnapshot();
    },
    ensureInitialGitCheckpoint,
    captureLatestGitCheckpoint: captureGitCheckpoint,
    async waitForGitCheckpoints() { await checkpointQueue; },
    gitCheckpoints,
    gitChangeTurns,
    dispose() {
      if (disposed) return;
      disposed = true;
      sessionNamingController.abort();
      unsubscribe();
      session.dispose();
      void settingsManager.flush();
    }
  };
}
