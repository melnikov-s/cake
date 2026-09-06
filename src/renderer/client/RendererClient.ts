import type { Effect } from "effect";
import type { ProjectSettings } from "../../domain/application-data";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import type {
  CompiledInlineWidget,
  InlineWidgetCapability,
  InlineWidgetLanguage,
  RepairedInlineWidget,
} from "../../ipc/inline-widget-contract";
import type { JsonValue } from "../../ipc/json-contract";
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
  WorktreeRebaseOutcome,
  WorktreeRecord,
  WorktreeStatus,
} from "../../ipc/worktree-contract";

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

type TerminalTarget = { readonly workingDirectory: string };

interface ElectronCommands {
  chooseProject(options?: RendererCommandOptions): Promise<string | undefined>;
  openExternalUrl(url: string, options?: RendererCommandOptions): Promise<void>;
  showNotification(
    input: {
      title: string;
      body: string;
      level: "info" | "success" | "warning" | "error";
      id?: string;
      groupId?: string;
    },
    options?: RendererCommandOptions,
  ): Promise<void>;
  showTranscriptSelectionContextMenu(
    input: { canChat: boolean; canAnnotate: boolean },
    options?: RendererCommandOptions,
  ): Promise<"chat-about-selection" | "add-annotation" | undefined>;
  showComposerContextMenu(
    input: { selection: string; x: number; y: number },
    options?: RendererCommandOptions,
  ): Promise<"reword" | "reword-with-prompt" | undefined>;
  showSessionContextMenu(
    input: {
      sessionId: string;
      x: number;
      y: number;
      resolved: boolean;
      unread?: boolean;
      familyChild?: boolean;
    },
    options?: RendererCommandOptions,
  ): Promise<"rename" | "mark-unread" | "resolve" | "unresolve" | "delete" | undefined>;
  showProjectContextMenu(
    input: { path: string; x: number; y: number; resolvedWorktreeCount: number },
    options?: RendererCommandOptions,
  ): Promise<"settings" | "remove-project" | "delete-resolved-worktrees" | undefined>;
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
  setProjectSettings(
    path: string,
    settings: ProjectSettings,
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
  prepareLanding(
    input: { operationId: string; workspacePath: string },
    options?: RendererCommandOptions,
  ): Promise<void>;
  land(
    input: { operationId: string; workspacePath: string; request: WorktreeLandRequest },
    options?: RendererCommandOptions,
  ): Promise<WorktreeLandOutcome>;
  cancelLanding(
    input: { operationId: string; workspacePath: string },
    options?: RendererCommandOptions,
  ): Promise<void>;
  rebase(
    input: { operationId: string; workspacePath: string },
    options?: RendererCommandOptions,
  ): Promise<WorktreeRebaseOutcome>;
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
  workingDirectoryStatus(
    workingDirectory: string,
    options?: RendererCommandOptions,
  ): Promise<{ runningProgramCount: number }>;
  close(terminalId: string, options?: RendererCommandOptions): Promise<void>;
  closeWorkingDirectory(workingDirectory: string, options?: RendererCommandOptions): Promise<void>;
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
    input: {
      visible: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
      projectSidebarWidth: number;
    },
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

interface InlineWidgetCommands {
  compile(
    language: InlineWidgetLanguage,
    source: string,
    capability: InlineWidgetCapability,
    options?: RendererCommandOptions,
  ): Promise<CompiledInlineWidget>;
  repair(
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
  readonly scheduledMessages: CommandGroup<CakeIpcClientService["scheduledMessages"]>;
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
  readonly inlineWidgets: InlineWidgetCommands;
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
