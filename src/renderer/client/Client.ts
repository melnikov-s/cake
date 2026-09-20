import type { Effect } from "effect";
import type {
  ArtifactLineageDetail,
  ArtifactLineageId,
  ArtifactLineagePage,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevision,
  ArtifactRevisionNumber,
  ArtifactRevisionPage,
  ArtifactReferenceMetadata,
  ArtifactStableRef,
  ArtifactTextComparison,
  EffectiveArtifactProjection,
} from "../../domain/artifacts/artifact-lineage";
import type { ArtifactProjectionMetadata } from "../../services/artifacts/ArtifactProjection";
import type { ProjectSettings } from "../../domain/application/application-data";
import type {
  ResolvedManagedWorktreeCleanupPlan,
  ResolvedManagedWorktreeCleanupResult,
} from "../../domain/worktrees/managed-worktree-cleanup-data";
import type {
  WorktreeLandingOperation,
  WorktreeLandingSnapshot,
} from "../../domain/worktrees/worktree-landing-data";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import type { EditorAnnotationSnapshot } from "../../ipc/editor-annotation";
import type { EditorLocation } from "../../ipc/editor-location";
import type {
  CompiledInlineWidget,
  InlineWidgetCapability,
  InlineWidgetLanguage,
} from "../../ipc/inline-widget-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type {
  Attachment,
  ApplicationState,
  FileSuggestion,
  ModelOption,
  ConversationSnapshot,
  UtilityModel,
} from "../../ipc/session-contract";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";

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

export interface BrowserStateSnapshot {
  readonly sessionId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly inspecting: boolean;
}

type TerminalTarget = { readonly workingDirectory: string };

type SessionContextMenuAction = {
  action: "rename" | "mark-unread" | "resolve" | "unresolve" | "delete";
};

interface ElectronCommands {
  chooseProject(options?: ClientCommandOptions): Promise<string | undefined>;
  saveDrawExport(
    input: {
      format: "png" | "svg" | "excalidraw";
      suggestedName: string;
      data: string;
    },
    options?: ClientCommandOptions,
  ): Promise<string | undefined>;
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
    },
    options?: ClientCommandOptions,
  ): Promise<SessionContextMenuAction | undefined>;
  showProjectContextMenu(
    input: {
      path: string;
      x: number;
      y: number;
      resolvedWorktreeCount: number;
      sessionSort: "date" | "label";
    },
    options?: ClientCommandOptions,
  ): Promise<
    | "settings"
    | "sort-by-date"
    | "sort-by-label"
    | "remove-project"
    | "delete-resolved-worktrees"
    | undefined
  >;
  setFullscreenSurfaceOpen(
    surfaceId: string,
    open: boolean,
    options?: ClientCommandOptions,
  ): Promise<void>;
}

interface BrowserCommands {
  open(
    sessionId: string,
    url?: string,
    options?: ClientCommandOptions,
  ): Promise<BrowserStateSnapshot>;
  state(sessionId: string, options?: ClientCommandOptions): Promise<BrowserStateSnapshot>;
  updateBounds(
    input: {
      sessionId: string;
      visible: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
    },
    options?: ClientCommandOptions,
  ): Promise<BrowserStateSnapshot>;
  navigate(
    sessionId: string,
    url: string,
    options?: ClientCommandOptions,
  ): Promise<BrowserStateSnapshot>;
  action(
    sessionId: string,
    action: "back" | "forward" | "reload" | "stop",
    options?: ClientCommandOptions,
  ): Promise<BrowserStateSnapshot>;
  inspect(sessionId: string, options?: ClientCommandOptions): Promise<BrowserStateSnapshot>;
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
  ): Promise<ConversationSnapshot["commands"]>;
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
      backgroundSetup?: boolean;
    },
    options?: ClientCommandOptions,
  ): Promise<WorktreeRecord>;
  landing(
    input: { workspacePath: string; sessionId: string },
    options?: ClientCommandOptions,
  ): Promise<WorktreeLandingSnapshot>;
  startLanding(
    input: {
      operationId: string;
      workspacePath: string;
      sessionId: string;
      strategy: "preserve" | "squash";
      allowDirtyTarget: boolean;
      commitBeforeLanding: boolean;
      resolveAfterLanding: boolean;
    },
    options?: ClientCommandOptions,
  ): Promise<WorktreeLandingOperation>;
  retryLanding(
    input: { operationId: string; workspacePath: string; sessionId: string },
    options?: ClientCommandOptions,
  ): Promise<WorktreeLandingOperation>;
  cancelLanding(
    input: {
      operationId: string;
      workspacePath: string;
      intent: "cancel" | "acknowledge";
    },
    options?: ClientCommandOptions,
  ): Promise<void>;
  startRebase(
    input: { operationId: string; workspacePath: string; sessionId: string },
    options?: ClientCommandOptions,
  ): Promise<WorktreeLandingOperation>;
  discard(
    input: { operationId: string; workspacePath: string; keepBranch: boolean },
    options?: ClientCommandOptions,
  ): Promise<void>;
  inspectResolvedForProject(
    projectPath: string,
    options?: ClientCommandOptions,
  ): Promise<ResolvedManagedWorktreeCleanupPlan>;
  discardResolvedForProject(
    projectPath: string,
    options?: ClientCommandOptions,
  ): Promise<ResolvedManagedWorktreeCleanupResult>;
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
    location: EditorLocation,
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
  catalog(
    input: { search?: string; offset?: number; limit?: number },
    options?: ClientCommandOptions,
  ): Promise<ArtifactLineagePage>;
  effective(
    sessionId: string,
    options?: ClientCommandOptions,
  ): Promise<ReadonlyArray<EffectiveArtifactProjection>>;
  detail(
    lineageId: ArtifactLineageId,
    options?: ClientCommandOptions,
  ): Promise<ArtifactLineageDetail>;
  history(
    input: { lineageId: ArtifactLineageId; offset?: number; limit?: number },
    options?: ClientCommandOptions,
  ): Promise<ArtifactRevisionPage>;
  readExact(
    lineageId: ArtifactLineageId,
    revision: ArtifactRevisionNumber,
    options?: ClientCommandOptions,
  ): Promise<ArtifactRevision>;
  referenceMetadata(
    reference: ArtifactStableRef,
    options?: ClientCommandOptions,
  ): Promise<ArtifactReferenceMetadata>;
  compareText(
    lineageId: ArtifactLineageId,
    fromRevision: ArtifactRevisionNumber,
    toRevision: ArtifactRevisionNumber,
    options?: ClientCommandOptions,
  ): Promise<ArtifactTextComparison>;
  restore(
    input: {
      sessionId: string;
      lineageId: ArtifactLineageId;
      sourceRevision: ArtifactRevisionNumber;
      expectedLatestRevision: number;
    },
    options?: ClientCommandOptions,
  ): Promise<ArtifactRevision>;
  link(
    input: {
      sessionId: string;
      lineageId: ArtifactLineageId;
      target: ArtifactLinkTarget;
      selection: ArtifactLink["selection"];
    },
    options?: ClientCommandOptions,
  ): Promise<ArtifactLink>;
  unlink(
    input: { sessionId: string; lineageId: ArtifactLineageId; target: ArtifactLinkTarget },
    options?: ClientCommandOptions,
  ): Promise<void>;
  setSelection(
    input: {
      sessionId: string;
      lineageId: ArtifactLineageId;
      target: ArtifactLinkTarget;
      selection: ArtifactLink["selection"];
    },
    options?: ClientCommandOptions,
  ): Promise<ArtifactLink>;
  materialize(
    sessionId: string,
    lineageId: ArtifactLineageId,
    revision: ArtifactRevisionNumber,
    options?: ClientCommandOptions,
  ): Promise<ArtifactProjectionMetadata>;
}

interface InlineWidgetCommands {
  compile(
    language: InlineWidgetLanguage,
    source: string,
    capability: InlineWidgetCapability,
    options?: ClientCommandOptions,
  ): Promise<CompiledInlineWidget>;
}

/** Permanent renderer-facing Promise API grouped by semantic Cake capability. */
export interface Client {
  readonly application: CommandGroup<CakeIpcClientService["application"]>;
  readonly windowState: CommandGroup<CakeIpcClientService["windowState"]>;
  readonly models: {
    readonly list: (options?: ClientCommandOptions) => Promise<ReadonlyArray<ModelOption>>;
    readonly refresh: (options?: ClientCommandOptions) => Promise<void>;
    readonly login: (
      input: { readonly provider: string; readonly authType: "api_key" | "oauth" },
      options?: ClientCommandOptions,
    ) => Promise<void>;
    readonly logout: (
      input: { readonly provider: string },
      options?: ClientCommandOptions,
    ) => Promise<void>;
  };
  readonly piSettings: CommandGroup<CakeIpcClientService["piSettings"]>;
  readonly modelPresets: CommandGroup<CakeIpcClientService["modelPresets"]>;
  readonly sessionChats: CommandGroup<CakeIpcClientService["sessionChats"]>;
  readonly projectSessions: CommandGroup<CakeIpcClientService["projectSessions"]>;
  readonly projectWorkflow: CommandGroup<CakeIpcClientService["projectWorkflow"]>;
  readonly scheduledMessages: CommandGroup<CakeIpcClientService["scheduledMessages"]>;
  readonly cakeChats: CommandGroup<CakeIpcClientService["cakeChats"]>;
  readonly discussionSessions: CommandGroup<CakeIpcClientService["discussionSessions"]>;
  readonly draw: CommandGroup<CakeIpcClientService["draw"]>;
  readonly drawControl: CommandGroup<CakeIpcClientService["drawControl"]>;
  readonly subagents: CommandGroup<CakeIpcClientService["subagents"]>;
  readonly electron: ElectronCommands;
  readonly filesystem: FilesystemCommands;
  readonly workspaces: WorkspaceCommands;
  readonly managedWorktrees: ManagedWorktreeCommands;
  readonly terminals: TerminalCommands;
  readonly browser: BrowserCommands;
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
