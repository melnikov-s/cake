import type { Effect } from "effect";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import type {
  CompiledInlineWidget,
  InlineWidgetCapability,
  InlineWidgetLanguage,
  RepairedInlineWidget,
} from "../../ipc/inline-widget-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type {
  PluginAgentOpenOptions,
  PluginAgentSnapshot,
  PluginCompletionRequest,
  PluginCompletionResult,
  SessionRef,
} from "../../ipc/plugin-agent-contract";
import type { SourceLocation } from "../../ipc/source-location";
import type {
  Attachment,
  ApplicationState,
  FileSuggestion,
  ModelOption,
  SessionSnapshot,
  UtilityModel,
} from "../../ipc/session-contract";
import type {
  WorktreeLandOutcome,
  WorktreeLandRequest,
  WorktreeRecord,
  WorktreeStatus,
} from "../../ipc/worktree-contract";
import type {
  CustomizationState,
  PluginDiagnostic,
  PluginPersistenceRecord,
  PluginPersistenceScope,
  PluginStatus,
} from "../../plugin/plugin-contract";

export interface RendererCommandOptions {
  readonly signal?: AbortSignal;
}

type CommandGroup<Group> = {
  readonly [
    Key in keyof Group as Group[Key] extends (
      ...args: infer _Arguments
    ) => Effect.Effect<unknown, unknown, unknown>
      ? Key
      : never
  ]: Group[Key] extends (...args: infer Arguments) => Effect.Effect<infer Success, unknown, unknown>
    ? (...args: [...Arguments, options?: RendererCommandOptions]) => Promise<Success>
    : never;
};

export type EmbeddedEditorStatus = "missing" | "downloading" | "starting" | "ready" | "failed";

export interface EmbeddedEditorStateSnapshot {
  readonly status: EmbeddedEditorStatus;
  readonly message?: string;
  readonly customPath?: string;
}

type TerminalTarget =
  | { readonly kind: "project"; readonly sessionId: string; readonly workspacePath: string }
  | { readonly kind: "cake-chat"; readonly sessionId: string };

interface ElectronCommands {
  chooseProject(options?: RendererCommandOptions): Promise<string | undefined>;
  openExternalUrl(url: string, options?: RendererCommandOptions): Promise<void>;
  showTranscriptSelectionContextMenu(
    input: { canChat: boolean; canAnnotate: boolean },
    options?: RendererCommandOptions,
  ): Promise<"chat-about-selection" | "add-annotation" | undefined>;
  showComposerContextMenu(
    input: { selection: string; x: number; y: number },
    options?: RendererCommandOptions,
  ): Promise<"reword" | "reword-with-prompt" | undefined>;
  showSessionContextMenu(
    input: { sessionId: string; x: number; y: number; resolved: boolean; unread?: boolean },
    options?: RendererCommandOptions,
  ): Promise<"rename" | "mark-unread" | "resolve" | "unresolve" | "delete" | undefined>;
  showProjectContextMenu(
    input: { path: string; x: number; y: number; resolvedWorktreeCount: number },
    options?: RendererCommandOptions,
  ): Promise<"remove-project" | "delete-resolved-worktrees" | undefined>;
  setFullscreenSurfaceOpen(
    surfaceId: string,
    open: boolean,
    options?: RendererCommandOptions,
  ): Promise<void>;
}

interface FilesystemCommands {
  chooseAttachments(options?: RendererCommandOptions): Promise<ReadonlyArray<Attachment>>;
  suggestFiles(
    workingDirectory: string,
    prefix: string,
    options?: RendererCommandOptions,
  ): Promise<ReadonlyArray<FileSuggestion>>;
  readFile(
    workingDirectory: string,
    path: string,
    options?: RendererCommandOptions,
  ): Promise<string>;
}

interface WorkspaceCommands {
  rewordComposerSelection(
    input: { selection: string; prompt?: string; workingDirectory?: string },
    options?: RendererCommandOptions,
  ): Promise<string>;
  generateSessionTitle(
    firstUserMessage: string,
    options?: RendererCommandOptions,
  ): Promise<string | undefined>;
  setUtilityModel(
    model: UtilityModel | undefined,
    options?: RendererCommandOptions,
  ): Promise<ApplicationState>;
  loadStagedSlashCommands(
    path: string,
    options?: RendererCommandOptions,
  ): Promise<SessionSnapshot["commands"]>;
  registerProject(
    path: string,
    name: string,
    options?: RendererCommandOptions,
  ): Promise<ApplicationState>;
  renameProject(
    path: string,
    name: string,
    options?: RendererCommandOptions,
  ): Promise<ApplicationState>;
  removeProject(
    path: string,
    deleteSessions: boolean,
    options?: RendererCommandOptions,
  ): Promise<ApplicationState>;
  deleteSession(sessionId: string, options?: RendererCommandOptions): Promise<ApplicationState>;
  setSessionUnread(
    sessionId: string,
    unread: boolean,
    options?: RendererCommandOptions,
  ): Promise<ApplicationState>;
  restartPi(path: string, options?: RendererCommandOptions): Promise<void>;
  inspect(
    input: { operationId: string; path: string },
    options?: RendererCommandOptions,
  ): Promise<void>;
  respondToTrust(
    input: { operationId: string; path: string; approved: boolean },
    options?: RendererCommandOptions,
  ): Promise<void>;
}

interface ManagedWorktreeCommands {
  create(
    input: {
      operationId: string;
      path: string;
      baseWorktreePath?: string;
      worktreeName?: string;
      firstUserMessage?: string;
    },
    options?: RendererCommandOptions,
  ): Promise<WorktreeRecord>;
  status(
    input: { workspacePath: string },
    options?: RendererCommandOptions,
  ): Promise<WorktreeStatus | undefined>;
  land(
    input: { operationId: string; workspacePath: string; request: WorktreeLandRequest },
    options?: RendererCommandOptions,
  ): Promise<WorktreeLandOutcome>;
  discard(
    input: { operationId: string; workspacePath: string; keepBranch: boolean },
    options?: RendererCommandOptions,
  ): Promise<void>;
}

interface TerminalCommands {
  open(
    input: { target: TerminalTarget; cols: number; rows: number },
    options?: RendererCommandOptions,
  ): Promise<{ terminalId: string; shell: string }>;
  write(terminalId: string, data: string, options?: RendererCommandOptions): Promise<void>;
  resize(
    terminalId: string,
    cols: number,
    rows: number,
    options?: RendererCommandOptions,
  ): Promise<void>;
  status(
    terminalId: string,
    options?: RendererCommandOptions,
  ): Promise<{ runningProgram: boolean }>;
  close(terminalId: string, options?: RendererCommandOptions): Promise<void>;
}

interface VsCodeCommands {
  getState(options?: RendererCommandOptions): Promise<EmbeddedEditorStateSnapshot>;
  install(options?: RendererCommandOptions): Promise<void>;
  setServerPath(
    path: string | undefined,
    options?: RendererCommandOptions,
  ): Promise<ApplicationState>;
  open(workingDirectory: string, options?: RendererCommandOptions): Promise<void>;
  updateBounds(
    input: { visible: boolean; x: number; y: number; width: number; height: number },
    options?: RendererCommandOptions,
  ): Promise<void>;
  reveal(
    workingDirectory: string,
    location: SourceLocation,
    options?: RendererCommandOptions,
  ): Promise<void>;
  openSourceControl(workingDirectory: string, options?: RendererCommandOptions): Promise<void>;
  updateAnnotations(
    workingDirectory: string,
    snapshot: EditorAnnotationSnapshot,
    options?: RendererCommandOptions,
  ): Promise<void>;
}

interface ArtifactCommands {
  respond(
    input: {
      operationId: string;
      sessionId: string;
      artifactRequestId: string;
      value?: JsonValue;
      cancelled: boolean;
    },
    options?: RendererCommandOptions,
  ): Promise<void>;
  respondToUi(
    input: {
      operationId: string;
      sessionId: string;
      uiRequestId: string;
      value?: string;
      cancelled: boolean;
    },
    options?: RendererCommandOptions,
  ): Promise<void>;
  export(sessionId: string, options?: RendererCommandOptions): Promise<string>;
}

interface PluginCommands {
  getCustomizationState(options?: RendererCommandOptions): Promise<CustomizationState>;
  getAuthoringReference(options?: RendererCommandOptions): Promise<string>;
  listFiles(
    options?: RendererCommandOptions,
  ): Promise<{ workingRevision: string; buildRevision: string; files: ReadonlyArray<string> }>;
  create(
    input: {
      pluginId: string;
      name: string;
      renderer: boolean;
      backend: boolean;
      scene: boolean;
      expectedWorkingRevision: string;
    },
    options?: RendererCommandOptions,
  ): Promise<{ workingRevision: string; buildRevision: string; files: ReadonlyArray<string> }>;
  readFile(pluginId: string, path: string, options?: RendererCommandOptions): Promise<string>;
  writeFile(
    pluginId: string,
    path: string,
    content: string,
    expectedWorkingRevision: string,
    options?: RendererCommandOptions,
  ): Promise<{ workingRevision: string; buildRevision: string; files: ReadonlyArray<string> }>;
  validate(
    expectedBaseRevision?: string,
    request?: string,
    expectedSourceRevision?: string,
    options?: RendererCommandOptions,
  ): Promise<{
    revision: string;
    sourceRevision: string;
    diagnostics: ReadonlyArray<PluginDiagnostic>;
    valid: boolean;
  }>;
  activate(
    revision: string,
    expectedSourceRevision: string,
    request?: string,
    options?: RendererCommandOptions,
  ): Promise<{ revision: string; activating: true }>;
  rollback(options?: RendererCommandOptions): Promise<CustomizationState>;
  useFactory(options?: RendererCommandOptions): Promise<CustomizationState>;
  list(options?: RendererCommandOptions): Promise<ReadonlyArray<PluginStatus>>;
  setEnabled(
    pluginId: string,
    enabled: boolean,
    options?: RendererCommandOptions,
  ): Promise<ReadonlyArray<PluginStatus>>;
  setActiveScene(
    pluginId?: string,
    options?: RendererCommandOptions,
  ): Promise<ReadonlyArray<PluginStatus>>;
  delete(pluginId: string, options?: RendererCommandOptions): Promise<ReadonlyArray<PluginStatus>>;
  compileInlineWidget(
    language: InlineWidgetLanguage,
    source: string,
    capability: InlineWidgetCapability,
    options?: RendererCommandOptions,
  ): Promise<CompiledInlineWidget>;
  repairInlineWidget(
    input: {
      sessionId: string;
      language: InlineWidgetLanguage;
      capability: InlineWidgetCapability;
      source: string;
      context: string;
      diagnostic?: string;
      model?: { provider: string; id: string };
    },
    options?: RendererCommandOptions,
  ): Promise<RepairedInlineWidget>;
  openAgent(
    pluginId: string,
    input: PluginAgentOpenOptions,
    implicitSession?: SessionRef,
    options?: RendererCommandOptions,
  ): Promise<PluginAgentSnapshot>;
  promptAgent(
    pluginId: string,
    handleId: string,
    delivery: "prompt" | "steer" | "follow-up",
    text: string,
    options?: RendererCommandOptions,
  ): Promise<PluginAgentSnapshot>;
  abortAgent(
    pluginId: string,
    handleId: string,
    options?: RendererCommandOptions,
  ): Promise<PluginAgentSnapshot>;
  detachAgent(pluginId: string, handleId: string, options?: RendererCommandOptions): Promise<void>;
  runCompletion(
    pluginId: string,
    requestId: string,
    request: PluginCompletionRequest,
    implicitSession?: SessionRef,
    options?: RendererCommandOptions,
  ): Promise<PluginCompletionResult>;
  cancelCompletion(
    pluginId: string,
    requestId: string,
    options?: RendererCommandOptions,
  ): Promise<void>;
  loadState(
    pluginId: string,
    key: string,
    scope: PluginPersistenceScope,
    options?: RendererCommandOptions,
  ): Promise<PluginPersistenceRecord | undefined>;
  saveState(
    input: {
      pluginId: string;
      key: string;
      scope: PluginPersistenceScope;
      value: JsonValue;
      expectedVersion: number;
    },
    options?: RendererCommandOptions,
  ): Promise<PluginPersistenceRecord>;
  callBackend(
    input: { pluginId: string; callId: string; method: string; input: JsonValue },
    options?: RendererCommandOptions,
  ): Promise<{ ok: boolean; value?: JsonValue; error?: string }>;
  cancelBackendCall(
    pluginId: string,
    callId: string,
    options?: RendererCommandOptions,
  ): Promise<void>;
  reportRendered(revision: string, options?: RendererCommandOptions): Promise<void>;
  reportRuntimeFailure(
    revision: string,
    message: string,
    options?: RendererCommandOptions,
  ): Promise<void>;
}

/** Permanent renderer-facing Promise API grouped by semantic Cake capability. */
export interface RendererClient {
  readonly application: CommandGroup<CakeIpcClientService["application"]>;
  readonly windowState: CommandGroup<CakeIpcClientService["windowState"]>;
  readonly models: {
    readonly list: (options?: RendererCommandOptions) => Promise<ReadonlyArray<ModelOption>>;
    readonly refresh: (options?: RendererCommandOptions) => Promise<void>;
  };
  readonly modelPresets: CommandGroup<CakeIpcClientService["modelPresets"]>;
  readonly projectSessions: CommandGroup<CakeIpcClientService["projectSessions"]>;
  readonly cakeChats: CommandGroup<CakeIpcClientService["cakeChats"]>;
  readonly discussionSessions: CommandGroup<CakeIpcClientService["discussionSessions"]>;
  readonly subagents: CommandGroup<CakeIpcClientService["subagents"]>;
  readonly electron: ElectronCommands;
  readonly filesystem: FilesystemCommands;
  readonly workspaces: WorkspaceCommands;
  readonly managedWorktrees: ManagedWorktreeCommands;
  readonly terminals: TerminalCommands;
  readonly vscode: VsCodeCommands;
  readonly artifacts: ArtifactCommands;
  readonly plugins: PluginCommands;
  readonly foundation: CommandGroup<CakeIpcClientService["foundation"]>;
}

export type RendererClientErrorKind = "interrupted" | "transport" | "rejected" | "unexpected";

export class RendererClientError extends Error {
  readonly _tag = "RendererClientError";

  constructor(
    readonly kind: RendererClientErrorKind,
    readonly operation: string,
    message: string,
    readonly details: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RendererClientError";
  }
}
