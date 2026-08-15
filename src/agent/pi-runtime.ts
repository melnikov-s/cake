import {
  DefaultResourceLoader,
  DefaultPackageManager,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getPackageDir,
  hasTrustRequiringProjectResources,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
  type InlineExtension,
  type SessionEntry,
  type SlashCommandInfo
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  Attachment,
  ModelOption,
  PiSettings,
  PiSettingUpdate,
  CompatibilityCatalog,
  ExtensionUiEvent,
  ExtensionUiState,
  FileSuggestion,
  ResourceDiagnostic,
  SessionSnapshot,
  SessionPreview,
  SessionSummary,
  ThinkingLevel,
  UiPart,
  SessionTreeEntry
} from "../ipc/session-contract";
import { REVIEW_TEXT_MAX_LENGTH, type ReviewMessage, type ReviewThreadRecord } from "../ipc/review-contract";
import { piBuiltinSlashCommands, SESSION_TITLE_MAX_LENGTH, slashCommandSchema } from "../ipc/session-contract";
import {
  artifactRecordSchema,
  artifactPointerSchema,
  parseArtifactInput,
  validateArtifactResponse,
  type ArtifactRecord,
  type ArtifactPointer,
  type CakeArtifactV1
} from "../ipc/artifact-contract";

export const piRuntimeVersion = "0.84.0" as const;
const gitCheckpointEntryType = "cake.git-checkpoint/v1";
const reviewRunEntryType = "cake.review-run/v1";
const reviewRunEntrySchema = z.object({
  operationId: z.uuid(),
  threadIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  commentCount: z.number().int().positive().max(1_000_000),
  status: z.enum(["running", "complete", "error"])
});
export type ReviewRunEntry = z.infer<typeof reviewRunEntrySchema>;
const gitCheckpointSchema = z.object({
  tree: z.string().regex(/^[0-9a-f]{40,64}$/),
  ref: z.string().min(1).max(1_024),
  capturedAt: z.string().datetime()
});
export type GitCheckpoint = z.infer<typeof gitCheckpointSchema>;

function boundedProjectionKey(value: string, maximum = 256) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, maximum - digest.length - 1)}:${digest}`;
}

export function loadPiChangelog() {
  try {
    return readFileSync(join(getPackageDir(), "CHANGELOG.md"), "utf8");
  } catch {
    return "# Changelog\n\nNo changelog entries found.";
  }
}

/** Resolve the Cake source tree that matches the running authoring skill. */
export function cakePluginAuthoringSkillPath(authoringRoot = process.env.CAKE_AUTHORING_ROOT ?? resolve(import.meta.dirname, "../..")) {
  return join(authoringRoot, ".agents", "skills", "cake-plugin-authoring");
}

export function inspectWorkspace(path: string) {
  return { path, trustRequired: hasTrustRequiringProjectResources(path) };
}

/** Mirror Pi's documented per-workspace directory layout beneath Cake's session root. */
export function cakeWorkspaceSessionDirectory(cwd: string, sessionRoot: string) {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(sessionRoot), safePath);
}

export async function suggestProjectFiles(options: { cwd: string; prefix: string; agentDir: string; fdPath?: string }): Promise<FileSuggestion[]> {
  const installedFd = join(options.agentDir, "bin", process.platform === "win32" ? "fd.exe" : "fd");
  const provider = new CombinedAutocompleteProvider([], options.cwd, options.fdPath ?? (existsSync(installedFd) ? installedFd : "fd"));
  const text = `@${options.prefix}`;
  const suggestions = await provider.getSuggestions([text], 0, text.length, { signal: AbortSignal.timeout(5_000) });
  return (suggestions?.items ?? []).slice(0, 20).map(({ value, label, description }) => ({ value, label, description }));
}

export async function listWorkspaceSessions(cwd: string, sessionDir: string): Promise<SessionSummary[]> {
  const sessions = await SessionManager.list(cwd, cakeWorkspaceSessionDirectory(cwd, sessionDir));
  const idsByPath = new Map(sessions.map((item) => [item.path, item.id]));
  return sessions.map((item) => ({
    id: item.id,
    title: (item.name || item.firstMessage || "New chat").slice(0, SESSION_TITLE_MAX_LENGTH),
    created: item.created.toISOString(),
    modified: item.modified.toISOString(),
    messageCount: item.messageCount,
    parentSessionId: item.parentSessionPath ? idsByPath.get(item.parentSessionPath) : undefined,
    archived: false
  }));
}

export async function loadWorkspaceSessionPreview(cwd: string, sessionId: string, sessionDir: string): Promise<SessionPreview | undefined> {
  const workspaceSessionDir = cakeWorkspaceSessionDirectory(cwd, sessionDir);
  const sessions = await SessionManager.list(cwd, workspaceSessionDir);
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) return undefined;
  const manager = SessionManager.open(target.path, workspaceSessionDir, cwd);
  return {
    workspacePath: cwd,
    sessionId,
    sessionFile: target.path,
    parts: projectSessionEntries(manager.getBranch())
  };
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
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  persistArtifact?(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact?(record: ArtifactRecord, signal: AbortSignal): Promise<unknown | undefined>;
  listArtifacts?(pointers: ArtifactPointer[]): Promise<ArtifactRecord[]>;
  openExternal?(url: string): Promise<void>;
  captureGitCheckpoint?(sessionId: string): Promise<{ tree: string; ref: string }>;
  globalControl?: {
    tools: readonly GlobalControlTool[];
    invoke(input: { name: string; arguments: unknown }, signal: AbortSignal): Promise<unknown>;
  };
  onEvent(event: CakeRuntimeEvent): void;
}

export interface GlobalControlTool {
  name: string;
  description: string;
}

export interface ReviewTurnOptions {
  cwd: string;
  trusted: boolean;
  thread: ReviewThreadRecord;
  sessionDir: string;
  parentSessionRoot: string;
  signal?: AbortSignal;
  instruction?: string;
  model?: { provider: string; id: string };
  parent?: ReviewParentContext;
  agentDir: string;
}

export interface ReviewParentContext {
  sessionId: string;
  sessionFile: string;
  leafId?: string;
  systemPrompt?: string;
  activeTools?: string[];
  model?: { provider: string; id: string };
}

export interface ReviewTurnResult {
  sessionId: string;
  sessionFile: string;
  error?: string;
}

const reviewParentEntryType = "cake.review-parent/v1";

interface ReviewParentMetadata {
  cacheKey: string;
  systemPrompt: string;
  activeTools: string[];
  model?: { provider: string; id: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewParentMetadata(value: unknown): ReviewParentMetadata | undefined {
  if (!isRecord(value) || typeof value.cacheKey !== "string" || typeof value.systemPrompt !== "string") return undefined;
  if (!Array.isArray(value.activeTools) || !value.activeTools.every((tool) => typeof tool === "string")) return undefined;
  const model = isRecord(value.model) && typeof value.model.provider === "string" && typeof value.model.id === "string"
    ? { provider: value.model.provider, id: value.model.id }
    : undefined;
  return { cacheKey: value.cacheKey, systemPrompt: value.systemPrompt, activeTools: value.activeTools, model };
}

function storedReviewParent(manager: SessionManager) {
  for (const entry of manager.getEntries().toReversed()) {
    if (entry.type === "custom" && entry.customType === reviewParentEntryType) return reviewParentMetadata(entry.data);
  }
  return undefined;
}

/** @internal Exported for deterministic cache-routing contract tests. */
export function routeReviewPromptCache(payload: unknown, metadata: ReviewParentMetadata): unknown {
  if (!isRecord(payload) || !("prompt_cache_key" in payload)) return payload;
  return { ...payload, prompt_cache_key: metadata.cacheKey };
}

function reviewForkExtension(metadata: ReviewParentMetadata, reviewContext: string): InlineExtension {
  return (pi) => {
    pi.on("before_agent_start", () => ({
      systemPrompt: metadata.systemPrompt,
      message: { customType: "cake.review-context", content: reviewContext, display: false }
    }));
    pi.on("before_provider_request", (event) => routeReviewPromptCache(event.payload, metadata));
  };
}

function reviewArtifactExtension(): InlineExtension {
  return createCakeArtifactExtension({
    persistArtifact: async (artifact) => artifactRecordSchema.parse({ artifact, workspacePath: "review", digest: "0".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    requestArtifact: async () => undefined
  });
}

export async function runReviewTurn(options: ReviewTurnOptions): Promise<ReviewTurnResult> {
  const agentDir = options.agentDir;
  const settingsManager = SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.trusted });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`
  });
  let sessionManager: SessionManager;
  let parentMetadata: ReviewParentMetadata | undefined;
  if (options.thread.agentSessionFile) {
    assertSessionPath(options.thread.agentSessionFile, options.sessionDir, "Review session file");
    sessionManager = SessionManager.open(options.thread.agentSessionFile, options.sessionDir, options.cwd);
    parentMetadata = storedReviewParent(sessionManager);
  } else if (options.parent?.sessionFile && options.parent.systemPrompt && options.parent.activeTools) {
    assertSessionPath(options.parent.sessionFile, options.parentSessionRoot, "Parent session file");
    sessionManager = SessionManager.forkFrom(options.parent.sessionFile, options.cwd, options.sessionDir);
    if (options.parent.leafId) sessionManager.branch(options.parent.leafId);
    parentMetadata = {
      cacheKey: options.parent.sessionId,
      systemPrompt: options.parent.systemPrompt,
      activeTools: options.parent.activeTools,
      model: options.parent.model
    };
    sessionManager.appendCustomEntry(reviewParentEntryType, parentMetadata);
  } else {
    sessionManager = SessionManager.create(options.cwd, options.sessionDir);
  }
  const resourceLoader = new DefaultResourceLoader(parentMetadata ? {
    cwd: options.cwd,
    agentDir,
    settingsManager,
    extensionFactories: [reviewArtifactExtension(), reviewForkExtension(parentMetadata, reviewContextMessage(options.thread, options.instruction))]
  } : {
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    systemPrompt: reviewSystemPrompt(options.thread, options.instruction)
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.trusted });
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager
  });
  try {
    if (options.signal?.aborted) throw new Error("The review run was cancelled");
    const abort = () => { void session.abort(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await session.bindExtensions({ mode: "rpc" });
      if (parentMetadata) session.setActiveToolsByName(parentMetadata.activeTools);
      if (options.model) {
        const model = modelRuntime.getModel(options.model.provider, options.model.id);
        if (!model) throw new Error(`Unknown review model ${options.model.provider}/${options.model.id}`);
        await session.setModel(model);
      }
      let failure = "";
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        if (event.message.errorMessage) failure = event.message.errorMessage;
      });
      try {
        await session.prompt(options.thread.pendingComments.map((comment) => comment.body).join("\n\n"), { source: "interactive" });
      } catch (error) {
        failure ||= error instanceof Error ? error.message : String(error);
      } finally {
        unsubscribe();
      }
      if (!session.sessionFile) throw new Error("The review agent session was not persisted");
      return { sessionId: session.sessionManager.getSessionId(), sessionFile: session.sessionFile, error: failure || undefined };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } finally {
    session.dispose();
  }
}

function reviewContextMessage(thread: ReviewThreadRecord, instruction?: string) {
  return `${reviewSystemPrompt(thread, instruction)}\n\nThe user's immediately preceding message in this review thread is the comment to address.`;
}

function reviewSystemPrompt(thread: ReviewThreadRecord, instruction?: string) {
  const point = (value: ReviewThreadRecord["anchor"]["start"]) => `diff row ${value.diffLine}${value.oldLine ? `, old line ${value.oldLine}` : ""}${value.newLine ? `, new line ${value.newLine}` : ""}${value.column === undefined ? "" : `, column ${value.column}`}`;
  return [
    "You are replying inside an inline code-review thread in Cake. This is an auxiliary review turn: do not discuss routing or the main chat. Address the review comment directly. You may inspect and edit the workspace when that is the clearest way to address it. Finish with a concise response suitable for the inline thread.",
    instruction?.trim() ? `Shared instruction from the reviewer:\n${instruction.trim()}` : "",
    `File: ${thread.anchor.path}\nRange: ${point(thread.anchor.start)} through ${point(thread.anchor.end)}`,
    thread.anchor.selectedText ? `Selected code:\n\`\`\`\n${thread.anchor.selectedText}\n\`\`\`` : "",
    `Context before:\n\`\`\`\n${thread.anchor.contextBefore}\n\`\`\`\nContext after:\n\`\`\`\n${thread.anchor.contextAfter}\n\`\`\``,
  ].filter(Boolean).join("\n\n");
}

export async function loadReviewSessionMessages(record: ReviewThreadRecord, sessionRoot: string): Promise<ReviewMessage[]> {
  if (!record.agentSessionFile) return [];
  assertSessionPath(record.agentSessionFile, sessionRoot, "Review session file");
  const targetDirectory = resolve(dirname(record.agentSessionFile));
  const manager = SessionManager.open(record.agentSessionFile, targetDirectory, record.workspacePath);
  const branch = manager.getBranch();
  const parentBoundary = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === reviewParentEntryType);
  return branch.slice(parentBoundary + 1).flatMap((entry): ReviewMessage[] => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") return [];
    const body = textFromContent(message.content).trim().slice(0, REVIEW_TEXT_MAX_LENGTH);
    if (!body) return [];
    return [{
      id: entry.id,
      role: message.role,
      body,
      createdAt: entry.timestamp,
      delivered: true,
      status: message.role === "assistant" && message.errorMessage ? "error" : "complete"
    }];
  });
}

export async function migrateLegacyReviewSession(thread: { workspacePath: string; messages: ReviewMessage[] }, sessionDir: string) {
  const manager = SessionManager.create(thread.workspacePath, sessionDir);
  const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const message of thread.messages) {
    const timestamp = new Date(message.createdAt).getTime();
    if (message.role === "user") manager.appendMessage({ role: "user", content: message.body, timestamp });
    else manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: message.body }],
      api: "cake-review-migration",
      provider: "cake",
      model: "legacy-review",
      usage: emptyUsage,
      stopReason: message.status === "error" ? "error" : "stop",
      errorMessage: message.status === "error" ? message.body : undefined,
      timestamp
    });
  }
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Cake could not migrate the legacy review conversation into Pi");
  return { sessionId: manager.getSessionId(), sessionFile };
}

export function createCakeArtifactExtension(options: Required<Pick<CakeRuntimeOptions, "persistArtifact" | "requestArtifact">>): InlineExtension {
  return (pi) => {
    const parameters = Type.Object({ artifact: Type.Any() });
    const persist = async (input: unknown, sessionId: string) => {
      const artifact = parseArtifactInput(input);
      if (artifact.sessionId !== sessionId) throw new Error("Artifact sessionId does not match the active Pi session");
      return options.persistArtifact(artifact);
    };
    const appendPointer = (record: ArtifactRecord) => {
      pi.appendEntry("cake.artifact/v1", artifactPointerSchema.parse({
        protocol: "cake.artifact/v1",
        artifactId: record.artifact.id,
        sessionId: record.artifact.sessionId,
        revision: record.artifact.revision,
        kind: record.artifact.kind,
        digest: record.digest,
        fallback: record.artifact.fallback
      }));
    };
    pi.registerTool({
      name: "ui_present",
      label: "Present artifact",
      description: "Create or explicitly revise a durable Cake artifact. Every artifact includes a readable Markdown fallback.",
      parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const record = await persist(params.artifact, ctx.sessionManager.getSessionId());
        if (record.artifact.interaction?.mode === "request") throw new Error("ui_present requires present interaction mode");
        appendPointer(record);
        return { content: [{ type: "text", text: `Presented ${record.artifact.kind} artifact ${record.artifact.id} at revision ${record.artifact.revision}.` }], details: { artifactId: record.artifact.id, revision: record.artifact.revision } };
      }
    });
    pi.registerTool({
      name: "ui_request",
      label: "Request artifact input",
      description: "Display a durable Cake form and wait for one validated user response or cancellation.",
      parameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const record = await persist(params.artifact, ctx.sessionManager.getSessionId());
        if (record.artifact.interaction?.mode !== "request") throw new Error("ui_request requires request interaction mode");
        appendPointer(record);
        const value = await options.requestArtifact(record, signal ?? new AbortController().signal);
        if (value === undefined) return { content: [{ type: "text", text: `The user cancelled artifact request ${record.artifact.id}.` }], details: { artifactId: record.artifact.id, cancelled: true } };
        const validated = validateArtifactResponse(record.artifact.interaction.responseSchema, value);
        return { content: [{ type: "text", text: `The user submitted a validated response for artifact ${record.artifact.id}: ${formatUnknown(validated, 8_000)}` }], details: { artifactId: record.artifact.id, cancelled: false, value: validated } };
      }
    });
    pi.registerCommand("cake-artifacts", {
      description: "Exercise Cake's built-in artifact renderers and structured response path",
      async handler(_args, ctx) {
        const sessionId = ctx.sessionManager.getSessionId();
        const table = await persist({
          protocol: "cake.artifact/v1", id: "cake-s4-table", sessionId, revision: 1, kind: "table", title: "S4 table",
          payload: { columns: [{ id: "name", label: "Name", type: "text" }, { id: "score", label: "Score", type: "number" }], rows: [{ id: "row-a", name: "Alpha", score: 2 }, { id: "row-b", name: "Beta", score: 1 }], selectable: true },
          fallback: { markdown: "| Name | Score |\n| --- | ---: |\n| Alpha | 2 |\n| Beta | 1 |" }, interaction: { mode: "present" }
        }, sessionId);
        appendPointer(table);
        const diagram = await persist({
          protocol: "cake.artifact/v1", id: "cake-s4-diagram", sessionId, revision: 1, kind: "diagram", title: "S4 diagram",
          payload: { source: "flowchart LR\n  Agent --> Artifact\n  Artifact --> User" },
          fallback: { markdown: "Agent → Artifact → User" }, interaction: { mode: "present" }
        }, sessionId);
        appendPointer(diagram);
        const html = await persist({
          protocol: "cake.artifact/v1", id: "cake-s4-html", sessionId, revision: 1, kind: "html", title: "Sandboxed HTML",
          payload: { html: "<strong>Isolated HTML</strong><script>parent.document.body.textContent='compromised';fetch('https://example.com')</script>" },
          fallback: { markdown: "**Isolated HTML**" }, interaction: { mode: "present" }
        }, sessionId);
        appendPointer(html);
        const form = await persist({
          protocol: "cake.artifact/v1", id: "cake-s4-form", sessionId, revision: 1, kind: "form", title: "S4 response",
          payload: { fields: [{ id: "answer", label: "Answer", type: "text", required: true }], submitLabel: "Send response" },
          fallback: { markdown: "S4 response form: **Answer** (required)." },
          interaction: { mode: "request", responseSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string", minLength: 1 } } } }
        }, sessionId);
        appendPointer(form);
        const value = await options.requestArtifact(form, new AbortController().signal);
        const validated = value === undefined ? undefined : validateArtifactResponse(form.artifact.interaction?.responseSchema, value);
        if (validated !== undefined) {
          const completedForm = await persist({ ...form.artifact, revision: 2, interaction: { mode: "present" }, fallback: { markdown: `${form.artifact.fallback.markdown}\n\n_Response submitted._` } }, sessionId);
          appendPointer(completedForm);
        }
        ctx.ui.notify(value === undefined ? "Artifact request cancelled" : "Artifact response received", value === undefined ? "warning" : "info");
        pi.sendMessage({ customType: "cake.artifact.demo", content: value === undefined ? "Artifact request cancelled." : `Artifact response: ${formatUnknown(validated, 1_000)}`, display: true });
      }
    });
  };
}

function controlToolParameters(name: string) {
  const target = { workspacePath: Type.String(), sessionId: Type.String() };
  if (name === "get_app_state") return Type.Object({});
  if (name === "list_sessions") return Type.Object({ workspacePath: Type.Optional(Type.String()), includeArchived: Type.Optional(Type.Boolean()), cursor: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer()) });
  if (name === "read_session") return Type.Object({ ...target, cursor: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer()) });
  if (name === "search_sessions") return Type.Object({ query: Type.String(), workspacePath: Type.Optional(Type.String()), includeArchived: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer()) });
  if (name === "create_session") return Type.Object({ workspacePath: Type.String() });
  if (name === "send_session_message") return Type.Object({ ...target, text: Type.String(), delivery: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("follow-up"), Type.Literal("steer")])) });
  if (name === "rename_session") return Type.Object({ ...target, title: Type.String() });
  if (name === "set_session_archived") return Type.Object({ ...target, archived: Type.Boolean() });
  if (name === "set_session_model") return Type.Object({ ...target, provider: Type.String(), modelId: Type.String() });
  return Type.Object(target);
}

function createGlobalControlExtension(control: NonNullable<CakeRuntimeOptions["globalControl"]>): InlineExtension {
  return (pi) => {
    for (const tool of control.tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.name.replaceAll("_", " "),
        description: tool.description,
        parameters: controlToolParameters(tool.name),
        async execute(_toolCallId, params, signal) {
          const result = await control.invoke({ name: tool.name, arguments: params }, signal ?? new AbortController().signal);
          return { content: [{ type: "text", text: formatUnknown(result, 24_000) }], details: result };
        }
      });
    }
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
  dispose(): void;
}

function formatUnknown(value: unknown, limit = 48_000) {
  let formatted: string;
  if (typeof value === "string") formatted = value;
  else {
    try {
      formatted = JSON.stringify(value, null, 2);
    } catch {
      formatted = String(value);
    }
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…` : formatted;
}

function formatToolInput(toolName: string, args: unknown) {
  if (toolName === "bash" && typeof args === "object" && args !== null) {
    const command = Reflect.get(args, "command");
    if (typeof command === "string") return formatUnknown(command);
  }
  return formatUnknown(args);
}

function toolFilePath(_toolName: string, args: unknown) {
  if (typeof args !== "object" || args === null) return undefined;
  const path = Reflect.get(args, "path") ?? Reflect.get(args, "file_path");
  return typeof path === "string" && path.length <= 8_192 ? path : undefined;
}

function toolResultDiff(_toolName: string, result: unknown) {
  if (typeof result !== "object" || result === null) return undefined;
  const details = Reflect.get(result, "details");
  if (typeof details !== "object" || details === null) return undefined;
  const diff = Reflect.get(details, "diff") ?? Reflect.get(details, "patch");
  return typeof diff === "string" ? diff : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && Reflect.get(item, "type") === "text" && typeof Reflect.get(item, "text") === "string")
    .map((item) => item.text)
    .join("\n");
}

function partsFromMessage(message: unknown, baseId: string, streaming = false, entryId?: string): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const role = Reflect.get(message, "role");
  const content = Reflect.get(message, "content");

  if (role === "user") {
    const parts: UiPart[] = [];
    const text = textFromContent(content);
    if (text) parts.push({ id: `${baseId}-text`, kind: "text", role: "user", entryId, text, status: "complete" });
    if (Array.isArray(content)) {
      content.forEach((item, index) => {
        if (typeof item === "object" && item !== null && Reflect.get(item, "type") === "image") {
          const data = Reflect.get(item, "data");
          parts.push({ id: `${baseId}-attachment-${index}`, kind: "attachment", name: `Image ${index + 1}`, mediaType: String(Reflect.get(item, "mimeType") ?? "image").slice(0, 128), attachmentKind: "image", data: typeof data === "string" && data.length <= 20_000_000 ? data : undefined });
        }
      });
    }
    return parts;
  }

  if (role === "assistant" && Array.isArray(content)) {
    const parts = content.flatMap((item, index): UiPart[] => {
      if (typeof item !== "object" || item === null) return [];
      const type = Reflect.get(item, "type");
      if (type === "text") {
        const text = String(Reflect.get(item, "text") ?? "");
        if (!text) return [];
        const sources = [...new Set(text.match(/https?:\/\/[^\s)\]}>,]+/g) ?? [])].filter((url) => url.length <= 8_192).slice(0, 20);
        return [
          { id: `${baseId}-text-${index}`, kind: "text", role: "assistant", entryId, text, status: streaming ? "streaming" : Reflect.get(message, "errorMessage") ? "error" : "complete" },
          ...sources.map((url, sourceIndex): UiPart => ({ id: `${baseId}-source-${index}-${sourceIndex}`, kind: "source", title: sourceTitle(url), url }))
        ];
      }
      if (type === "thinking") {
        return [{ id: `${baseId}-reasoning-${index}`, kind: "reasoning", text: String(Reflect.get(item, "thinking") ?? ""), status: streaming ? "streaming" : "complete" }];
      }
      if (type === "toolCall") {
        const name = String(Reflect.get(item, "name") ?? "tool");
        const args = Reflect.get(item, "arguments");
        return [{ id: boundedProjectionKey(`tool-${String(Reflect.get(item, "id"))}`), kind: "tool", name, input: formatToolInput(name, args), filePath: toolFilePath(name, args), state: "running" }];
      }
      return [];
    });
    const errorMessage = Reflect.get(message, "errorMessage");
    if (!parts.some((part) => part.kind === "text") && typeof errorMessage === "string" && errorMessage.trim()) {
      parts.push({ id: `${baseId}-error`, kind: "notice", tone: "error", title: "Model request failed", detail: errorMessage.trim() });
    }
    return parts;
  }

  if (role === "toolResult") {
    const name = String(Reflect.get(message, "toolName") ?? "tool");
    const details = Reflect.get(message, "details");
    return [{
      id: boundedProjectionKey(`tool-${String(Reflect.get(message, "toolCallId"))}`),
      kind: "tool",
      name,
      input: "",
      output: textFromContent(content) || formatUnknown(details),
      diff: toolResultDiff(name, { details }),
      state: Reflect.get(message, "isError") ? "error" : "success"
    }];
  }

  if (role === "custom" && Reflect.get(message, "display") === true) {
    return [{ id: `${baseId}-custom`, kind: "notice", tone: "info", title: String(Reflect.get(message, "customType") ?? "Extension"), detail: textFromContent(content) }];
  }
  return [];
}

export function createLiveMessageProjector() {
  let activeStreamId: string | undefined;
  let streamIndex = 0;

  const nextStreamId = () => `stream-${++streamIndex}`;

  return (event: AgentSessionEvent): UiPart[] => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      activeStreamId = nextStreamId();
      return [];
    }
    if (event.type === "message_update") {
      activeStreamId ??= nextStreamId();
      return partsFromMessage(event.message, activeStreamId, true);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      activeStreamId ??= nextStreamId();
      const parts = partsFromMessage(event.message, activeStreamId);
      activeStreamId = undefined;
      return parts;
    }
    return [];
  };
}

function reviewRunPart(run: ReviewRunEntry): Extract<UiPart, { kind: "review-run" }> {
  return { id: `review-run-${run.operationId}`, kind: "review-run", ...run };
}

function projectSessionEntries(entries: readonly SessionEntry[], branchEntries: readonly SessionEntry[] = entries) {
  const projected: UiPart[] = [];
  const indexes = new Map<string, number>();
  const append = (part: UiPart) => {
    const existingIndex = indexes.get(part.id);
    if (existingIndex === undefined) {
      indexes.set(part.id, projected.length);
      projected.push(part);
      return;
    }
    const existing = projected[existingIndex];
    projected[existingIndex] = existing?.kind === "tool" && part.kind === "tool"
      ? { ...existing, ...part, input: part.input || existing.input, filePath: part.filePath || existing.filePath }
      : part;
  };

  const visibleRunIds = new Set(entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) return [];
    const run = reviewRunEntrySchema.safeParse(entry.data);
    return run.success ? [run.data.operationId] : [];
  }));
  const compactedRuns = new Map<string, ReviewRunEntry>();
  for (const entry of branchEntries) {
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) continue;
    const run = reviewRunEntrySchema.safeParse(entry.data);
    if (run.success && !visibleRunIds.has(run.data.operationId)) compactedRuns.set(run.data.operationId, run.data);
  }
  for (const run of compactedRuns.values()) append(reviewRunPart(run));

  for (const entry of entries) {
    if (entry.type === "message") {
      for (const part of partsFromMessage(entry.message, `entry-${entry.id}`, false, entry.id)) append(part);
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) continue;
    const run = reviewRunEntrySchema.safeParse(entry.data);
    if (run.success) append(reviewRunPart(run.data));
  }
  return projected;
}

function imageContent(attachments: Attachment[]) {
  return attachments.flatMap((attachment) => attachment.kind === "image"
    ? [{ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }]
    : []);
}

function promptText(text: string, attachments: Attachment[]) {
  const mentions = attachments.filter((item) => item.kind === "file").map((item) => `@${item.path}`);
  return mentions.length ? `${text}\n\n${mentions.join("\n")}` : text;
}

function sourceTitle(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
}

function entryPreview(entry: { type: string }) {
  const value = entry as unknown as Record<string, unknown>;
  if (entry.type === "message") {
    const message = value.message as Record<string, unknown> | undefined;
    const role = String(message?.role ?? "message");
    const text = textFromContent(message?.content).replace(/[\n\t]+/g, " ").trim();
    if (role === "user") return text.slice(0, 2_048);
    if (role === "assistant") {
      if (text) return text.slice(0, 2_048);
      if (message?.stopReason === "aborted") return "(aborted)";
      if (message?.errorMessage) return String(message.errorMessage).replace(/[\n\t]+/g, " ").trim().slice(0, 2_048);
      return "";
    }
    if (role === "toolResult") return `[${String(message?.toolName ?? "tool")}]`;
    if (role === "bashExecution") return `[bash]: ${String(message?.command ?? "")}`.slice(0, 2_048);
    return `[${role}]`;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return String(value.summary ?? "").slice(0, 2_048);
  if (entry.type === "session_info") return String(value.name ?? "Session renamed").slice(0, 2_048);
  if (entry.type === "model_change") return `${String(value.provider ?? "")}/${String(value.modelId ?? "")}`;
  return entry.type.replaceAll("_", " ");
}

function entryMessageValue(entry: object, key: string) {
  const message = Reflect.get(entry, "message");
  return typeof message === "object" && message !== null ? Reflect.get(message, key) : undefined;
}

function projectTree(sessionManager: SessionManager): SessionTreeEntry[] {
  const activeIds = new Set(sessionManager.getBranch().map((entry) => entry.id));
  const entries: SessionTreeEntry[] = [];
  const stack = [...sessionManager.getTree()].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    entries.push({
      id: node.entry.id,
      parentId: node.entry.parentId ?? undefined,
      type: node.entry.type,
      messageRole: node.entry.type === "message" ? String(entryMessageValue(node.entry, "role") ?? "message") : undefined,
      editorText: node.entry.type === "message" && entryMessageValue(node.entry, "role") === "user"
        ? textFromContent(entryMessageValue(node.entry, "content"))
        : undefined,
      label: node.label,
      preview: entryPreview(node.entry),
      active: activeIds.has(node.entry.id)
    });
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!);
  }
  return entries;
}

function projectArtifactPointers(sessionManager: SessionManager): ArtifactPointer[] {
  const pointers = new Map<string, ArtifactPointer>();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || Reflect.get(entry, "customType") !== "cake.artifact/v1") continue;
    const parsed = artifactPointerSchema.safeParse(Reflect.get(entry, "data"));
    if (!parsed.success) continue;
    const current = pointers.get(parsed.data.artifactId);
    if (!current || parsed.data.revision > current.revision) pointers.set(parsed.data.artifactId, parsed.data);
  }
  return [...pointers.values()];
}

function compatibilityCatalog(
  resourceLoader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string
): CompatibilityCatalog {
  const extensions = resourceLoader.getExtensions();
  const skills = resourceLoader.getSkills();
  const prompts = resourceLoader.getPrompts();
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages();
  const resources: CompatibilityCatalog["resources"] = [];

  for (const skill of skills.skills) resources.push({
    id: `skill:${skill.filePath}`.slice(0, 8_192), kind: "skill", name: skill.name,
    description: skill.description, path: skill.filePath, source: skill.sourceInfo.source,
    scope: skill.sourceInfo.scope, origin: skill.sourceInfo.origin, commands: [], tools: [], enabled: true
  });
  for (const prompt of prompts.prompts) resources.push({
    id: `prompt:${prompt.filePath}`.slice(0, 8_192), kind: "prompt", name: prompt.name,
    description: prompt.description, path: prompt.filePath, source: prompt.sourceInfo.source,
    scope: prompt.sourceInfo.scope, origin: prompt.sourceInfo.origin, commands: [], tools: [], enabled: true
  });
  for (const extension of extensions.extensions) resources.push({
    id: `extension:${extension.resolvedPath}`.slice(0, 8_192), kind: "extension",
    name: extension.path.split(/[\\/]/).pop() ?? extension.path, path: extension.path,
    source: extension.sourceInfo.source, scope: extension.sourceInfo.scope,
    origin: extension.sourceInfo.origin, commands: [...extension.commands.keys()].filter((name) => name.length <= 256).sort(),
    tools: [...extension.tools.keys()].filter((name) => name.length <= 256).sort(), enabled: !extension.hidden
  });
  for (const configured of packages) resources.push({
    id: `package:${configured.scope}:${configured.source}`.slice(0, 8_192), kind: "package",
    name: configured.source, path: configured.installedPath, source: configured.source,
    scope: configured.scope, origin: "package", commands: [], tools: [], enabled: !configured.filtered
  });

  const diagnostics: ResourceDiagnostic[] = [
    ...extensions.errors.map((error, index) => ({ id: `extension:${index}:${error.path}`, severity: "error" as const, source: "extension" as const, message: error.error, path: error.path })),
    ...skills.diagnostics.map((item, index) => ({ id: `skill:${index}:${item.path ?? item.message}`.slice(0, 8_192), severity: item.type === "error" ? "error" as const : "warning" as const, source: "skill" as const, message: item.message, path: item.path })),
    ...resourceLoader.getPrompts().diagnostics.map((item, index) => ({ id: `prompt:${index}:${item.path ?? item.message}`.slice(0, 8_192), severity: item.type === "error" ? "error" as const : "warning" as const, source: "prompt" as const, message: item.message, path: item.path }))
  ];
  return { resources, diagnostics };
}

function createCakeExtensionUiContext(options: {
  request(request: RuntimeUiRequest): Promise<string | undefined>;
  emit(event: ExtensionUiEvent): void;
  state: ExtensionUiState;
  addDiagnostic(method: string, message: string): void;
}): ExtensionUIContext {
  let editorText = "";
  const degraded = (method: string, detail: string) => options.addDiagnostic(method, `${method} is unavailable in Cake: ${detail}`);
  const dialog = (request: RuntimeUiRequest) => options.request(request);
  const setWidget = (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => {
    key = boundedProjectionKey(key);
    if (typeof content === "function") {
      degraded("setWidget(component)", "terminal Component factories cannot be translated to React; provide legacy string lines or a Cake widget");
      return;
    }
    const placement = widgetOptions?.placement ?? "aboveEditor";
    const index = options.state.widgets.findIndex((widget) => widget.key === key);
    if (content === undefined) {
      if (index >= 0) options.state.widgets.splice(index, 1);
      options.emit({ kind: "widget", key, placement });
      return;
    }
    const lines = Array.isArray(content) ? content.map(String).slice(0, 1_000) : [];
    const widget = { key, lines, placement };
    if (index >= 0) options.state.widgets.splice(index, 1, widget);
    else options.state.widgets.push(widget);
    options.emit({ kind: "widget", ...widget });
  };

  return {
    async select(title, values, opts) {
      const projected = values.slice(0, 100).map((value) => ({ id: boundedProjectionKey(value), label: value, value }));
      const selected = await dialog({ kind: "select", title, message: title, options: projected.map(({ id, label }) => ({ id, label })), signal: opts?.signal, timeout: opts?.timeout });
      return projected.find((option) => option.id === selected)?.value;
    },
    async confirm(title, message, opts) { return (await dialog({ kind: "confirm", title, message, signal: opts?.signal, timeout: opts?.timeout })) === "true"; },
    input: (title, placeholder, opts) => dialog({ kind: "text", title, message: title, placeholder, signal: opts?.signal, timeout: opts?.timeout }),
    notify(message, tone = "info") { options.emit({ kind: "notify", id: crypto.randomUUID(), message, tone }); },
    onTerminalInput() { degraded("onTerminalInput", "raw terminal input has no desktop equivalent"); return () => undefined; },
    setStatus(key, text) {
      key = boundedProjectionKey(key);
      const index = options.state.statuses.findIndex((status) => status.key === key);
      if (text === undefined) { if (index >= 0) options.state.statuses.splice(index, 1); }
      else if (index >= 0) options.state.statuses.splice(index, 1, { key, text });
      else options.state.statuses.push({ key, text });
      options.emit({ kind: "status", key, text });
    },
    setWorkingMessage(message) { degraded("setWorkingMessage", message ? "Cake owns its streaming indicator" : "Cake owns its streaming indicator"); },
    setWorkingVisible() { degraded("setWorkingVisible", "Cake owns streaming visibility"); },
    setWorkingIndicator() { degraded("setWorkingIndicator", "terminal animation frames are not web UI"); },
    setHiddenThinkingLabel() { degraded("setHiddenThinkingLabel", "Cake uses its accessible reasoning label"); },
    setWidget,
    setFooter() { degraded("setFooter", "terminal footer factories cannot run in the renderer"); },
    setHeader() { degraded("setHeader", "terminal header factories cannot run in the renderer"); },
    setTitle(title) { options.state.title = title; options.emit({ kind: "title", title }); },
    async custom() { degraded("custom", "arbitrary TUI components require a Cake artifact or widget fallback"); return undefined as never; },
    pasteToEditor(text) { editorText += text; options.emit({ kind: "editor-text", text, mode: "insert" }); },
    setEditorText(text) { editorText = text; options.emit({ kind: "editor-text", text, mode: "replace" }); },
    getEditorText: () => editorText,
    editor: (title, prefill) => dialog({ kind: "editor", title, message: title, initialValue: prefill ?? "", multiline: true }),
    addAutocompleteProvider() { degraded("addAutocompleteProvider", "terminal autocomplete providers cannot attach to the web composer"); },
    setEditorComponent() { degraded("setEditorComponent", "terminal editor components cannot replace the web composer"); },
    getEditorComponent: () => undefined,
    get theme() { degraded("theme", "Pi TUI themes are not Cake renderer themes"); return unsupported("theme"); },
    getAllThemes: () => [],
    getTheme(name) { degraded("getTheme", `Pi TUI theme ${name} is unavailable`); return undefined; },
    setTheme() { degraded("setTheme", "extensions cannot replace Cake's renderer theme"); return { success: false, error: "Pi TUI themes are unavailable in Cake" }; },
    getToolsExpanded: () => false,
    setToolsExpanded() { degraded("setToolsExpanded", "tool expansion is controlled by the Cake transcript"); }
  };
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
    systemPrompt: "You are Cake's global application assistant. Help the user find, understand, navigate, and control their Cake sessions. Use the provided application tools instead of filesystem or shell tools. Earlier messages are part of the conversation; resolve follow-up references from them. Refresh live application state with tools when it may have changed. Never claim an action succeeded unless its tool result says it did."
  } : {
    cwd: options.cwd,
    agentDir,
    settingsManager,
    additionalSkillPaths: [cakePluginAuthoringSkillPath()],
    extensionFactories: [createCakeArtifactExtension({ persistArtifact, requestArtifact }), commandCatalogExtension]
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
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
    ...(options.globalControl ? { noTools: "builtin" as const } : {})
  });
  const cakeSessionId = session.sessionManager.getSessionId();
  let disposed = false;
  let checkpointQueue = Promise.resolve<unknown>(undefined);
  let reloadRequested = 0;
  let reloadCompleted = 0;
  let reloadInFlight: Promise<void> | undefined;
  const projectLiveMessage = createLiveMessageProjector();
  const catalog = compatibilityCatalog(resourceLoader, settingsManager, options.cwd, agentDir);
  const extensionUiState: ExtensionUiState = { statuses: [], widgets: [] };
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
    const sessions = await listWorkspaceSessions(options.cwd, options.sessionDir);
    const stats = session.getSessionStats();
    const globalSettings = settingsManager.getGlobalSettings();
    return {
      workspacePath: options.cwd,
      sessionId: cakeSessionId,
      sessionFile: session.sessionFile ?? "",
      parts: projectSessionEntries(session.sessionManager.buildContextEntries(), session.sessionManager.getBranch()),
      model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : undefined,
      models: await modelOptions(),
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
      piSettings: {
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

  function gitCheckpoints() {
    const checkpoints: GitCheckpoint[] = [];
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== gitCheckpointEntryType) continue;
      const parsed = gitCheckpointSchema.safeParse(entry.data);
      if (parsed.success) checkpoints.push(parsed.data);
    }
    return checkpoints;
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

  const activeToolCalls = new Map<string, { input: string; filePath?: string }>();
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (disposed) return;
    if (event.type === "agent_start") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: true });
    }
    for (const part of projectLiveMessage(event)) {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
    }
    if (event.type === "tool_execution_start") {
      const call = { input: formatToolInput(event.toolName, event.args), filePath: toolFilePath(event.toolName, event.args) };
      activeToolCalls.set(event.toolCallId, call);
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: boundedProjectionKey(`tool-${event.toolCallId}`), kind: "tool", name: event.toolName, ...call, state: "running" } });
    }
    if (event.type === "tool_execution_update") {
      const call = activeToolCalls.get(event.toolCallId) ?? { input: formatToolInput(event.toolName, event.args), filePath: toolFilePath(event.toolName, event.args) };
      activeToolCalls.set(event.toolCallId, call);
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: boundedProjectionKey(`tool-${event.toolCallId}`), kind: "tool", name: event.toolName, ...call, output: formatUnknown(event.partialResult), state: "running" } });
    }
    if (event.type === "tool_execution_end") {
      const call = activeToolCalls.get(event.toolCallId);
      activeToolCalls.delete(event.toolCallId);
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: boundedProjectionKey(`tool-${event.toolCallId}`), kind: "tool", name: event.toolName, input: call?.input ?? "", output: formatUnknown(event.result), filePath: call?.filePath, diff: toolResultDiff(event.toolName, event.result), state: event.isError ? "error" : "success" } });
    }
    if (event.type === "auto_retry_start") {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "active-retry", kind: "notice", tone: "warning", title: `Retry ${event.attempt}/${event.maxAttempts}`, detail: event.errorMessage } });
    }
    if (event.type === "compaction_start") {
      options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part: { id: "active-compaction", kind: "notice", tone: "info", title: "Compacting context", detail: event.reason } });
    }
    if (event.type === "agent_settled") {
      options.onEvent({ type: "streaming", sessionId: cakeSessionId, streaming: false });
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
      if (update.key === "autoCompact") session.setAutoCompactionEnabled(update.value);
      else if (update.key === "autoResizeImages") settingsManager.setImageAutoResize(update.value);
      else if (update.key === "blockImages") settingsManager.setBlockImages(update.value);
      else if (update.key === "enableSkillCommands") settingsManager.setEnableSkillCommands(update.value);
      else if (update.key === "steeringMode") session.setSteeringMode(update.value);
      else if (update.key === "followUpMode") session.setFollowUpMode(update.value);
      else if (update.key === "transport") {
        settingsManager.setTransport(update.value);
        session.agent.transport = update.value;
      }
      else if (update.key === "httpIdleTimeoutMs") settingsManager.setHttpIdleTimeoutMs(update.value);
      else if (update.key === "hideThinkingBlock") settingsManager.setHideThinkingBlock(update.value);
      else if (update.key === "mermaidRenderingMode") settingsManager.setMermaidRenderingMode(update.value);
      else if (update.key === "showCacheMissNotices") settingsManager.setShowCacheMissNotices(update.value);
      else if (update.key === "collapseChangelog") settingsManager.setCollapseChangelog(update.value);
      else if (update.key === "quietStartup") settingsManager.setQuietStartup(update.value);
      else if (update.key === "enableInstallTelemetry") settingsManager.setEnableInstallTelemetry(update.value);
      else if (update.key === "defaultProjectTrust") settingsManager.setDefaultProjectTrust(update.value);
      else if (update.key === "doubleEscapeAction") settingsManager.setDoubleEscapeAction(update.value);
      else if (update.key === "treeFilterMode") settingsManager.setTreeFilterMode(update.value);
      else if (update.key === "anthropicExtraUsageWarning") settingsManager.setWarnings({ ...settingsManager.getWarnings(), anthropicExtraUsage: update.value });
      else if (update.key === "retryEnabled") settingsManager.setRetryEnabled(update.value);
      else if (update.key === "shellPath") settingsManager.setShellPath(update.value.trim() || undefined);
      else if (update.key === "shellCommandPrefix") settingsManager.setShellCommandPrefix(update.value.trim() || undefined);
      else if (update.key === "npmCommand") settingsManager.setNpmCommand(update.value.length > 0 ? update.value : undefined);
      else if (update.key === "packages") settingsManager.setPackages(update.value);
      else if (update.key === "extensions") settingsManager.setExtensionPaths(update.value);
      else if (update.key === "skills") settingsManager.setSkillPaths(update.value);
      else if (update.key === "prompts") settingsManager.setPromptTemplatePaths(update.value);
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
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      session.dispose();
      void settingsManager.flush();
    }
  };
}

function assertSessionPath(sessionFile: string, sessionRoot: string, label: string) {
  const pathFromRoot = relative(resolve(sessionRoot), resolve(dirname(sessionFile)));
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} is outside Cake's Pi session directory`);
  }
}

export type FoundationRuntimeEvent =
  | { type: "text-delta"; text: string }
  | { type: "session-ready"; sessionId: string };

export interface FoundationRuntimeOptions {
  cwd: string;
  agentDir: string;
  requestConfirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
  onEvent(event: FoundationRuntimeEvent): void;
}

export interface FoundationRuntime {
  readonly sessionId: string;
  readonly sessionFile: undefined;
  run(): Promise<void>;
  dispose(): void;
}

const foundationExtension: InlineExtension = (pi) => {
  pi.registerCommand("cake-foundation", {
    description: "Exercise Cake's Pi session and extension UI boundaries",
    async handler(_args, ctx) {
      const accepted = await ctx.ui.confirm(
        "Pi extension confirmation",
        "This request came from a Pi extension running outside the renderer."
      );
      const chunks = accepted
        ? ["Pi", " session", " boundary", " is", " alive."]
        : ["Pi", " extension", " confirmation", " was", " declined."];

      for (const content of chunks) {
        pi.sendMessage({ customType: "cake.foundation", content, display: true });
      }
    }
  });
};

function unsupported(name: string): never {
  throw new Error(`Pi extension UI method ${name} is not supported by the S0 Cake adapter`);
}

function createFoundationUiContext(
  requestConfirm: FoundationRuntimeOptions["requestConfirm"]
): ExtensionUIContext {
  const noop = () => undefined;

  return {
    select: async () => undefined,
    confirm: (title, message, options) => requestConfirm(title, message, options?.signal),
    input: async () => undefined,
    notify: noop,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => unsupported("custom"),
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    get theme() {
      return unsupported("theme");
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme selection is not supported in S0" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop
  };
}

function projectEvent(event: AgentSessionEvent): FoundationRuntimeEvent | undefined {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    return { type: "text-delta", text: event.assistantMessageEvent.delta };
  }

  if (
    event.type === "message_end" &&
    event.message.role === "custom" &&
    event.message.customType === "cake.foundation" &&
    typeof event.message.content === "string"
  ) {
    return { type: "text-delta", text: event.message.content };
  }

  return undefined;
}

export async function createFoundationRuntime(
  options: FoundationRuntimeOptions
): Promise<FoundationRuntime> {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories: [foundationExtension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    noTools: "all",
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager
  });
  const unsubscribe = session.subscribe((event) => {
    const projected = projectEvent(event);
    if (projected) options.onEvent(projected);
  });

  await session.bindExtensions({
    mode: "rpc",
    uiContext: createFoundationUiContext(options.requestConfirm)
  });
  options.onEvent({ type: "session-ready", sessionId: session.sessionId });

  let disposed = false;
  return {
    sessionId: session.sessionId,
    sessionFile: undefined,
    async run() {
      if (disposed) throw new Error("The Pi foundation runtime has been disposed");
      await session.prompt("/cake-foundation", { source: "extension" });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      session.dispose();
    }
  };
}
