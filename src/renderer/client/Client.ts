import type { Effect } from "effect";
import type { ProjectSettings, ProjectWorkflowColor } from "../../domain/application-data";
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

export interface ClientCommandOptions {
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
    ? (...args: [...Arguments, options?: ClientCommandOptions]) => Promise<Success>
    : never;
};

export type EmbeddedEditorStatus = "missing" | "downloading" | "starting" | "ready" | "failed";

export interface EmbeddedEditorStateSnapshot {
  readonly status: EmbeddedEditorStatus;
  readonly message?: string;
  readonly customPath?: string;
}

type TerminalTarget = { readonly workingDirectory: string };

type SessionContextMenuAction =
  | { action: "rename" | "mark-unread" | "resolve" | "unresolve" | "delete" }
  | { action: "set-status"; statusId: string };

interface ElectronCommands {
  chooseProject(options?: ClientCommandOptions): Promise<string | undefined>;
  openExternalUrl(url: string, options?: ClientCommandOptions): Promise<void>;
  showNotification(
    input: {
      title: string;
      body: string;
      level: "info" | "success" | "warning" | "error";
      id?: string;
      groupId?: string;
    },
    options?: ClientCommandOptions,
  ): Promise<void>;
  showTranscriptSelectionContextMenu(
    input: { canChat: boolean; canAnnotate: boolean },
    options?: ClientCommandOptions,
  ): Promise<"chat-about-selection" | "add-annotation" | undefined>;
  showComposerContextMenu(
    input: { selection: string; x: number; y: number },
    options?: ClientCommandOptions,
  ): Promise<"reword" | "reword-with-prompt" | undefined>;
  showSessionContextMenu(
    input: {
      sessionId: string;
      x: number;
      y: number;
      resolved: boolean;
      draft: boolean;
      unread?: boolean;
      familyChild?: boolean;
      workflow?: {
        currentStatus: string;
        statuses: ReadonlyArray<{
          id: string;
          name: string;
          color: ProjectWorkflowColor;
        }>;
      };
    },
    options?: ClientCommandOptions,
  ): Promise<SessionContextMenuAction | undefined>;
  showProjectContextMenu(
    input: { path: string; x: number; y: number; resolvedWorktreeCount: number },
    options?: ClientCommandOptions,
  ): Promise<"settings" | "remove-project" | "delete-resolved-worktrees" | undefined>;
  setFullscreenSurfaceOpen(
    surfaceId: string,
    open: boolean,
    options?: ClientCommandOptions,
  ): Promise<void>;
}

interface FilesystemCommands {
  chooseAttachments(options?: ClientCommandOptions): Promise<ReadonlyArray<Attachment>>;
  suggestFiles(
    workingDirectory: string,
    prefix: string,
    options?: ClientCommandOptions,
  ): Promise<ReadonlyArray<FileSuggestion>>;
  readFile(workingDirectory: string, path: string, options?: ClientCommandOptions): Promise<string>;
}

interface WorkspaceCommands {
  rewordComposerSelection(
    input: { selection: string; prompt?: string; workingDirectory?: string },
    options?: ClientCommandOptions,
  ): Promise<string>;
  generateSessionTitle(
    firstUserMessage: string,
    options?: ClientCommandOptions,
  ): Promise<string | undefined>;
  setUtilityModel(
    model: UtilityModel | undefined,
    options?: ClientCommandOptions,
  ): Promise<ApplicationState>;
  loadStagedSlashCommands(
    path: string,
    options?: ClientCommandOptions,
  ): Promise<SessionSnapshot["commands"]>;
  registerProject(
    path: string,
    name: string,
    options?: ClientCommandOptions,
  ): Promise<ApplicationState>;
  renameProject(
    path: string,
    name: string,
    options?: ClientCommandOptions,
  ): Promise<ApplicationState>;
  setProjectSettings(
    path: string,
    settings: ProjectSettings,
    options?: ClientCommandOptions,
  ): Promise<ApplicationState>;
  removeProject(
    path: string,
    deleteSessions: boolean,
    options?: ClientCommandOptions,
  ): Promise<ApplicationState>;
  deleteSession(sessionId: string, options?: ClientCommandOptions): Promise<ApplicationState>;
  setSessionUnread(
    sessionId: string,
    unread: boolean,
    options?: ClientCommandOptions,
  ): Promise<ApplicationState>;
  restartPi(path: string, options?: ClientCommandOptions): Promise<void>;
  inspect(
    input: { operationId: string; path: string },
    options?: ClientCommandOptions,
  ): Promise<{ operationId: string; path: string; trustRequired: boolean }>;
  respondToTrust(
    input: { operationId: string; path: string; approved: boolean },
    options?: ClientCommandOptions,
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
    options?: ClientCommandOptions,
  ): Promise<WorktreeRecord>;
  status(
    input: { workspacePath: string },
    options?: ClientCommandOptions,
  ): Promise<WorktreeStatus | undefined>;
  prepareLanding(
    input: { operationId: string; workspacePath: string },
    options?: ClientCommandOptions,
  ): Promise<void>;
  land(
    input: { operationId: string; workspacePath: string; request: WorktreeLandRequest },
    options?: ClientCommandOptions,
  ): Promise<WorktreeLandOutcome>;
  cancelLanding(
    input: { operationId: string; workspacePath: string },
    options?: ClientCommandOptions,
  ): Promise<void>;
  rebase(
    input: { operationId: string; workspacePath: string },
    options?: ClientCommandOptions,
  ): Promise<WorktreeRebaseOutcome>;
  discard(
    input: { operationId: string; workspacePath: string; keepBranch: boolean },
    options?: ClientCommandOptions,
  ): Promise<void>;
}

interface TerminalCommands {
  open(
    input: { target: TerminalTarget; cols: number; rows: number },
    options?: ClientCommandOptions,
  ): Promise<{ terminalId: string; shell: string }>;
  write(terminalId: string, data: string, options?: ClientCommandOptions): Promise<void>;
  resize(
    terminalId: string,
    cols: number,
    rows: number,
    options?: ClientCommandOptions,
  ): Promise<void>;
  workingDirectoryStatus(
    workingDirectory: string,
    options?: ClientCommandOptions,
  ): Promise<{ runningProgramCount: number }>;
  close(terminalId: string, options?: ClientCommandOptions): Promise<void>;
  closeWorkingDirectory(workingDirectory: string, options?: ClientCommandOptions): Promise<void>;
}

interface VsCodeCommands {
  getState(options?: ClientCommandOptions): Promise<EmbeddedEditorStateSnapshot>;
  install(options?: ClientCommandOptions): Promise<void>;
  setServerPath(
    path: string | undefined,
    options?: ClientCommandOptions,
  ): Promise<ApplicationState>;
  open(workingDirectory: string, options?: ClientCommandOptions): Promise<void>;
  updateBounds(
    input: {
      visible: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
      projectSidebarWidth: number;
    },
    options?: ClientCommandOptions,
  ): Promise<void>;
  reveal(
    workingDirectory: string,
    location: SourceLocation,
    options?: ClientCommandOptions,
  ): Promise<void>;
  openSourceControl(workingDirectory: string, options?: ClientCommandOptions): Promise<void>;
  updateAnnotations(
    workingDirectory: string,
    snapshot: EditorAnnotationSnapshot,
    options?: ClientCommandOptions,
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
    options?: ClientCommandOptions,
  ): Promise<void>;
  respondToUi(
    input: {
      operationId: string;
      sessionId: string;
      uiRequestId: string;
      value?: string;
      cancelled: boolean;
    },
    options?: ClientCommandOptions,
  ): Promise<void>;
  export(sessionId: string, options?: ClientCommandOptions): Promise<string>;
}

interface InlineWidgetCommands {
  compile(
    language: InlineWidgetLanguage,
    source: string,
    capability: InlineWidgetCapability,
    options?: ClientCommandOptions,
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
    options?: ClientCommandOptions,
  ): Promise<RepairedInlineWidget>;
}

/** Permanent renderer-facing Promise API grouped by semantic Cake capability. */
export interface Client {
  readonly application: CommandGroup<CakeIpcClientService["application"]>;
  readonly windowState: CommandGroup<CakeIpcClientService["windowState"]>;
  readonly models: {
    readonly list: (options?: ClientCommandOptions) => Promise<ReadonlyArray<ModelOption>>;
    readonly refresh: (options?: ClientCommandOptions) => Promise<void>;
  };
  readonly modelPresets: CommandGroup<CakeIpcClientService["modelPresets"]>;
  readonly projectSessions: CommandGroup<CakeIpcClientService["projectSessions"]>;
  readonly projectWorkflow: CommandGroup<CakeIpcClientService["projectWorkflow"]>;
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

export type ClientErrorKind = "interrupted" | "transport" | "rejected" | "unexpected";

export class ClientError extends Error {
  readonly _tag = "ClientError";

  constructor(
    readonly kind: ClientErrorKind,
    readonly operation: string,
    message: string,
    readonly details: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientError";
  }
}
