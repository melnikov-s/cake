import { Store, batch, child, createStore, effect as reactiveEffect } from "r-state-tree";
import type { ProjectSessionStartInput } from "../../domain/project-sessions/project-session-data";
import type { SourceLocation } from "../../ipc/source-location";
import type { ChatConfiguration } from "../../ipc/session-contract";
import { reviewThreadAnnotations } from "../../utils/review-thread-annotations";
import type { StoreEvent } from "../events/StoreEvent";
import type {
  AgentAvailabilitySnapshot,
  AgentAvailabilityState,
} from "../../domain/application/agent-availability-data";
import { EmbeddedEditorStore } from "./EmbeddedEditorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { ExtensionUiStore } from "./ExtensionUiStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";
import { CommandPaneStore } from "./CommandPaneStore";
import { SessionManagementStore } from "./SessionManagementStore";
import { SessionContinuationStore } from "./SessionContinuationStore";
import { WorktreeCreationStore, type WorktreeDraftChoice } from "./WorktreeCreationStore";
import { ProjectOpenStore, type ProjectOpenResult } from "./ProjectOpenStore";
import type { WorkingDirectoryRetirementWorkflow } from "./WorkingDirectoryRetirementStore";

export interface ProjectWorkbenchStoreProps {
  retirement: WorkingDirectoryRetirementWorkflow;
  sessionRegistry: SessionRegistryStore;
  operations: SessionOperationCoordinatorStore;
  projects: ProjectCatalogStore;
  defaultConfiguration?(): ChatConfiguration | undefined;
  reviews(): ReviewsStore;
  extensionUi(): ExtensionUiStore;
  catalog: SessionCatalogStore;
  startCakeChat(prompt?: string): Promise<void>;
  /** Removes resolved worktree sessions from history and chooses the next conversation. */
  onWorktreeSessionsResolved(sessionIds: readonly string[], projectPath: string): Promise<void>;
  /** Navigates the shell to an existing session by ID. */
  openSessionById(sessionId: string): Promise<void>;
  /** The Project Session retained by the application shell as its active conversation. */
  activeSessionId(): string | undefined;
  /** Restores the focused pane's retained unsent session for this Project, when present. */
  restoreStagedSession?(projectPath: string): string | undefined;
  /** Selects a Project Session in the application shell. */
  selectSession(sessionId: string): void;
  toggleProjectSidebar(): void;
  enterIdeSidebarMode(): void;
  leaveIdeSidebarMode(): void;
  projectSidebarWidth(): number;
  paneNumber?(sessionId: string): number | undefined;
}

/** Coordinates accepted Project opens with Project Session and workbench presentation. */
export class ProjectWorkbenchStore extends Store<ProjectWorkbenchStoreProps> {
  readonly process = "renderer" as const;

  get client() {
    return ClientContext.consume(this)!;
  }
  agentAvailability: AgentAvailabilityState = "available";
  agentAvailabilityReason: string | undefined;
  error: string | undefined;
  errorDetails: string | undefined;
  /** Session context the current error belongs to; context-free errors are undefined. */
  private errorSessionId: string | undefined;
  private sessionOpenRevision = 0;
  private reopenAfterAgentRestart = false;

  private get reviews() {
    return this.props.reviews();
  }
  private get extensionUi() {
    return this.props.extensionUi();
  }

  @child
  get projectOpenStore(): ProjectOpenStore {
    return createStore(ProjectOpenStore, {
      operations: this.props.operations,
      projects: this.props.projects,
      onOpening: () => {
        this.sessionOpenRevision += 1;
        this.extensionUi.clear();
      },
      onAccepted: (result) => this.acceptProjectOpen(result),
    });
  }

  @child
  get embeddedEditorStore(): EmbeddedEditorStore {
    return createStore(EmbeddedEditorStore, {
      projectPath: () => this.projectOpenStore.projectPath,
      ideMode: () => this.activeSession?.ideMode ?? false,
      setIdeMode: (active) => {
        if (active) this.activeSession?.enterIde();
        else this.activeSession?.leaveIde();
      },
      chatSidebarVisible: () => this.activeSession?.ideChatSidebarVisible ?? true,
      toggleChatSidebar: () => this.activeSession?.toggleIdeChatSidebar(),
      showChatSidebar: () => this.activeSession?.showIdeChatSidebar(),
      chatSidebarWidth: () => this.activeSession?.ideChatSidebarWidth ?? 420,
      setChatSidebarWidth: (width) => this.activeSession?.setIdeChatSidebarWidth(width),
      annotations: () => {
        const sessionId = this.activeSessionId;
        if (!sessionId) return undefined;
        return reviewThreadAnnotations(
          sessionId,
          this.reviews.codeThreadsForSession(sessionId),
          (threadId) => this.reviews.threadStreaming(threadId),
        );
      },
      startCakeChat: (prompt) => this.props.startCakeChat(prompt),
      enterProjectSidebarMode: () => this.props.enterIdeSidebarMode(),
      leaveProjectSidebarMode: () => this.props.leaveIdeSidebarMode(),
      projectSidebarWidth: () => this.props.projectSidebarWidth(),
    });
  }

  @child
  get commandPaneStore(): CommandPaneStore {
    return createStore(CommandPaneStore, {
      operations: this.props.operations,
      editorText: (entryId) =>
        this.session?.tree.find((entry) => entry.piId === entryId)?.editorText,
      setDraft: (value) =>
        this.activeSession?.conversationSessionStore.composerStore.draftStore.setText(value),
      requestComposerFocus: () =>
        this.activeSession?.conversationSessionStore.composerStore.draftStore.requestFocus(),
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get sessionManagementStore(): SessionManagementStore {
    return createStore(SessionManagementStore, {
      operations: this.props.operations,
      catalog: this.props.catalog,
      projects: this.props.projects,
      registry: this.sessionRegistry,
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get sessionContinuationStore(): SessionContinuationStore {
    return createStore(SessionContinuationStore, {
      operations: this.props.operations,
      createWorktree: async (projectPath, name, baseWorktreePath) => {
        const record = await this.worktreeCreationStore.create(projectPath, {
          name,
          baseWorktreePath,
          backgroundSetup: true,
        });
        return record.worktreePath;
      },
      sessionContext: () => this.sessionContext(),
      sessionTitle: () => this.sessionTitle,
      closeCommandPane: () => this.commandPaneStore.close(),
      openSession: async (sessionId, workingDirectory) => {
        this.sessionRegistry.load(sessionId, workingDirectory);
        await this.props.openSessionById(sessionId);
      },
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get worktreeCreationStore(): WorktreeCreationStore {
    return createStore(WorktreeCreationStore, {
      operations: this.props.operations,
      catalog: this.props.catalog,
      relocateTemporarySession: (sessionId, workspacePath) => {
        this.sessionRegistry.pendingSessions.relocate(sessionId, workspacePath);
        if (this.activeSessionId === sessionId) this.projectOpenStore.activate(workspacePath);
      },
      reportError: (error) => this.setError(error),
    });
  }

  get isBusy() {
    return this.activeOperations.length > 0;
  }
  get activeOperations() {
    return this.props.operations.active("project-workbench");
  }

  get sessionRegistry() {
    return this.props.sessionRegistry;
  }

  get activeSessionId() {
    return this.props.activeSessionId();
  }

  get activeSession() {
    return this.activeSessionId
      ? this.sessionRegistry.findSession(this.activeSessionId)
      : undefined;
  }

  get session() {
    return this.activeSession?.model;
  }

  /** False for a staged or explicit draft session; Pi lists it only after activation. */
  get activeSessionExists(): boolean {
    const sessionId = this.activeSessionId;
    return sessionId !== undefined && !this.sessionRegistry.pendingSessions.isTemporary(sessionId);
  }

  get sessionTitle() {
    const context = this.sessionContext();
    const title = context ? this.props.catalog.find(context.sessionId)?.title : undefined;
    return title ?? "New chat";
  }

  canSubmitSession(sessionId: string) {
    if (!this.isActiveSession(sessionId)) return false;
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session) return false;
    if (this.sessionRegistry.pendingSessions.isTemporary(sessionId)) return true;
    const command = session.conversationSessionStore.composerStore.draftStore.text
      .trim()
      .toLocaleLowerCase();
    const local = command === "/tree" || command === "/resources" || command === "/changelog";
    return local || this.agentAvailability === "available";
  }

  paneNumber(sessionId: string) {
    return this.props.paneNumber?.(sessionId);
  }

  private markSessionRead(sessionId: string) {
    this.sessionRegistry.findSession(sessionId)?.markRead();
    // Opening a session also settles a user-marked unread reminder.
    if (this.props.catalog.find(sessionId)?.unread)
      void this.sessionManagementStore.setSessionUnread(sessionId, false);
  }

  startOperation() {
    const operationId = this.props.operations.start("project-workbench");
    this.error = undefined;
    this.errorDetails = undefined;
    return operationId;
  }

  finishOperation(operationId: string) {
    this.props.operations.finish(operationId);
  }

  setError(error: unknown, context?: string, sessionId = this.activeSessionId) {
    const described = describeError(error, context);
    this.error = described.message;
    this.errorDetails = described.details;
    this.errorSessionId = sessionId;
  }

  /**
   * The workbench error as seen from one session context: an error raised while a
   * session was displayed belongs to that session only, and context-free errors
   * (project picking, startup) surface only where no session is displayed.
   */
  contextError(
    sessionId: string | undefined,
  ): { message: string; details: string | undefined } | undefined {
    if (!this.error || this.errorSessionId !== sessionId) return undefined;
    return { message: this.error, details: this.errorDetails };
  }

  /** Re-authorizes the hydrated Working Directory before loading executable project resources. */
  async initialize(selection?: { workspacePath: string; sessionId: string }) {
    if (selection) {
      this.projectOpenStore.activate(selection.workspacePath);
      if (!this.sessionRegistry.findSession(selection.sessionId))
        this.sessionRegistry.load(selection.sessionId, selection.workspacePath);
      else this.sessionRegistry.observationRetention.retain(selection.sessionId);
    }
    const path = this.projectOpenStore.projectPath;
    if (!path) return;
    const sessionId = this.activeSessionId;
    const temporary = sessionId
      ? this.sessionRegistry.pendingSessions.isTemporary(sessionId)
      : true;
    await this.projectOpenStore.initialize({
      path,
      newSession: temporary,
      sessionId,
      stagedSession:
        temporary &&
        sessionId !== undefined &&
        !this.sessionRegistry.pendingSessions.isDraft(sessionId),
    });
  }

  async renameProject(path: string, name: string) {
    try {
      await this.client.workspaces.renameProject(path, name, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async removeProject(path: string, deleteSessions: boolean) {
    try {
      await this.client.workspaces.removeProject(path, deleteSessions, { signal: this.signal });
      if (this.signal.aborted) return false;
      this.projectOpenStore.clear(path);
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
      return false;
    }
  }

  async deleteResolvedWorktrees(path: string) {
    try {
      const plan = await this.client.managedWorktrees.inspectResolvedForProject(path, {
        signal: this.signal,
      });
      if (this.signal.aborted || !(await this.props.retirement.prepare(plan.workingDirectories)))
        return false;
      const result = await this.client.managedWorktrees.discardResolvedForProject(path, {
        signal: this.signal,
      });
      if (this.signal.aborted) return false;
      if (result.failures.length > 0) {
        this.setError(
          new Error(result.failures.map((failure) => failure.message).join("\n")),
          "Deleting resolved worktrees",
        );
        return false;
      }
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.setError(error, "Deleting resolved worktrees");
      return false;
    }
  }

  async startNewSession(path = this.projectOpenStore.projectPath) {
    if (
      this.activeSession &&
      this.sessionRegistry.pendingSessions.isStaged(this.activeSession.sessionId)
    ) {
      this.activeSession.conversationSessionStore.composerStore.draftStore.requestFocus();
      return;
    }
    if (!path) {
      await this.projectOpenStore.chooseProject();
      return;
    }
    const stagedSessionId = this.props.restoreStagedSession?.(path);
    if (stagedSessionId) {
      this.projectOpenStore.cancelPending();
      this.props.selectSession(stagedSessionId);
      this.showLoadedSession(stagedSessionId);
      return;
    }
    const sessionId = crypto.randomUUID();
    if (path === this.projectOpenStore.projectPath)
      this.showTemporarySession(path, sessionId, true);
    else
      await this.projectOpenStore.inspectPath(path, {
        newSession: true,
        sessionId,
        stagedSession: true,
      });
  }

  newSessionRequest(sessionId: string) {
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session || !this.sessionRegistry.pendingSessions.isTemporary(sessionId)) return undefined;
    return {
      path: session.workspacePath,
      configuration:
        this.sessionRegistry.pendingSessions.conversation(sessionId)?.configuration ??
        this.props.defaultConfiguration?.(),
      name: this.sessionRegistry.pendingSessions.conversation(sessionId)?.name,
    };
  }

  /** Creates and saves a Cake-owned draft in the background without changing selection. */
  async createDraftSession(
    path: string,
    name: string,
    initialPrompt: string,
    configuration?: ChatConfiguration,
  ) {
    const sessionId = crypto.randomUUID();
    this.sessionRegistry.pendingSessions.prepare(path, sessionId);
    const conversation = this.sessionRegistry.pendingSessions.conversation(sessionId)!;
    conversation.setName(name);
    if (configuration) conversation.setConfiguration(configuration);
    try {
      await this.sessionRegistry.pendingSessions.createDraft(sessionId, initialPrompt, []);
      return sessionId;
    } catch (error) {
      this.sessionRegistry.removeSession(sessionId);
      throw error;
    }
  }

  /** Creates, names, and starts a session in the background without changing selection. */
  async createSession(
    path: string,
    name: string,
    initialPrompt: string,
    configuration?: ChatConfiguration,
    renderUserMessageAsMarkdown = true,
  ) {
    const sessionId = crypto.randomUUID();
    this.sessionRegistry.pendingSessions.prepare(path, sessionId);
    const conversation = this.sessionRegistry.pendingSessions.conversation(sessionId)!;
    conversation.setName(name);
    if (configuration) conversation.setConfiguration(configuration);
    const input: ProjectSessionStartInput = configuration
      ? {
          sessionId,
          workingDirectory: path,
          text: initialPrompt,
          renderUserMessageAsMarkdown,
          attachments: [],
          name,
          configuration,
        }
      : {
          sessionId,
          workingDirectory: path,
          text: initialPrompt,
          renderUserMessageAsMarkdown,
          attachments: [],
          name,
        };
    this.sessionRegistry.pendingSessions.projectSubmission(sessionId, name);
    try {
      await this.client.projectSessions.start(input, { signal: this.signal });
      this.sessionRegistry.pendingSessions.materialize(sessionId, path);
      return sessionId;
    } catch (error) {
      this.sessionRegistry.removeSession(sessionId);
      throw error;
    }
  }

  configureDraftActivation(sessionId: string, choice: WorktreeDraftChoice) {
    this.worktreeCreationStore.select(sessionId, choice);
  }

  sessionCreationChoice(sessionId: string) {
    return this.worktreeCreationStore.choice(sessionId);
  }

  draftActivationCandidates(sessionId: string) {
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session) return [];
    const projectPath =
      this.props.catalog.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    return this.worktreeCreationStore.candidates(projectPath);
  }

  async prepareNewSession(sessionId: string, firstUserMessage: string) {
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session || !this.sessionRegistry.pendingSessions.isTemporary(sessionId)) return true;
    const projectPath =
      this.props.catalog.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    const sessionName = this.sessionRegistry.pendingSessions.conversation(sessionId)?.name;
    return this.worktreeCreationStore.prepare(
      sessionId,
      projectPath,
      firstUserMessage,
      sessionName,
    );
  }

  async resolveWorktreeWorkspace(
    workspacePath: string,
    options: { initiatingSessionId: string; workingDirectoryRetired?: boolean },
  ) {
    if (!options.workingDirectoryRetired && !(await this.props.retirement.prepare([workspacePath])))
      return;
    try {
      const result = await this.client.projectSessions.resolveWorkingDirectory(
        { workingDirectory: workspacePath },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      // Resolving a Working Directory can archive several sessions. Only replace the
      // visible conversation when the session whose action started this workflow is
      // still focused; a sibling selected while resolution was in flight must stay put.
      if (this.props.activeSessionId() === options.initiatingSessionId)
        await this.props.onWorktreeSessionsResolved(result.resolvedSessionIds, result.projectPath);
      if (result.failures.length > 0)
        this.setError(
          new Error(result.failures.map((failure) => failure.message).join("\n")),
          "Resolving Working Directory",
        );
    } catch (error) {
      if (!this.signal.aborted) this.setError(error, "Resolving Working Directory");
    }
  }

  private suspendEmbeddedEditor() {
    this.activeSession?.conversationSessionStore.composerStore.draftStore.setEditorContextAttachment(
      undefined,
    );
    this.embeddedEditorStore.suspend();
  }

  /** Explicitly returns the active session to its Agent presentation. */
  backToAgent() {
    this.activeSession?.conversationSessionStore.composerStore.draftStore.setEditorContextAttachment(
      undefined,
    );
    this.embeddedEditorStore.hide();
    this.activeSession?.conversationSessionStore.composerStore.draftStore.requestFocus();
  }

  restoreSessionPresentation() {
    if (this.activeSession?.ideMode) void this.embeddedEditorStore.restore();
  }

  private showTemporarySession(
    path: string,
    sessionId: string,
    staged = false,
    acceptedProjectOpen = false,
  ) {
    this.sessionOpenRevision += 1;
    if (!acceptedProjectOpen) this.projectOpenStore.cancelPending();
    const session = staged
      ? this.sessionRegistry.pendingSessions.prepareStaged(path, sessionId)
      : this.sessionRegistry.pendingSessions.prepare(path, sessionId);
    this.suspendEmbeddedEditor();
    this.projectOpenStore.activate(path);
    this.props.selectSession(sessionId);
    this.markSessionRead(sessionId);
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    session.conversationSessionStore.composerStore.draftStore.requestFocus();
    void session.stagedCommandStore.load(path);
  }

  openSession(sessionId: string) {
    return this.openSessionTarget(sessionId, false);
  }

  private async openSessionTarget(sessionId: string, acceptedProjectOpen: boolean) {
    const revision = ++this.sessionOpenRevision;
    if (!acceptedProjectOpen) this.projectOpenStore.cancelPending();
    const summary = this.props.catalog.find(sessionId);
    const existingSession = this.sessionRegistry.findSession(sessionId);
    const workspacePath = summary?.workingDirectory ?? existingSession?.workspacePath;
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    const alreadyActive = this.activeSessionId === sessionId;
    this.error = undefined;
    this.errorDetails = undefined;
    this.errorSessionId = undefined;
    if (
      alreadyActive &&
      workspacePath === this.projectOpenStore.projectPath &&
      sessionId === this.session?.sessionId
    ) {
      this.props.selectSession(sessionId);
      this.restoreSessionPresentation();
      return;
    }
    if (existingSession && this.sessionRegistry.pendingSessions.isTemporary(sessionId)) {
      this.activateLoadedSession(sessionId);
      return;
    }
    const hydrated = Boolean(existingSession?.model.sessionFile);
    if (hydrated) this.activateLoadedSession(sessionId);
    else if (existingSession) this.sessionRegistry.observationRetention.retain(sessionId);
    try {
      await this.client.projectSessions.open(
        { sessionId, workingDirectory: workspacePath },
        { signal: this.signal },
      );
      if (this.signal.aborted || revision !== this.sessionOpenRevision) return;
      if (!existingSession) this.sessionRegistry.load(sessionId, workspacePath);
      if (!hydrated) {
        const ready = await this.waitForSessionHydration(sessionId);
        if (!ready || this.signal.aborted || revision !== this.sessionOpenRevision) return;
        this.activateLoadedSession(sessionId);
      }
      this.props.projects.recordOpened(
        this.props.catalog.projectOfManagedWorktree(workspacePath) ?? workspacePath,
      );
    } catch (error) {
      if (!this.signal.aborted && revision === this.sessionOpenRevision)
        this.setError(error, "Opening Project Session", sessionId);
    }
  }

  private activateLoadedSession(sessionId: string) {
    batch(() => {
      this.props.selectSession(sessionId);
      this.showLoadedSessionTarget(sessionId, true);
      this.markSessionRead(sessionId);
    });
  }

  /** Keeps the current transcript mounted until the destination's first snapshot is applied. */
  private waitForSessionHydration(sessionId: string): Promise<boolean> {
    if (this.sessionRegistry.findSession(sessionId)?.model.sessionFile)
      return Promise.resolve(true);
    if (this.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", abort);
        dispose();
        resolve(ready);
      };
      const abort = () => finish(false);
      this.signal.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        if (this.sessionRegistry.findSession(sessionId)?.model.sessionFile)
          queueMicrotask(() => finish(true));
      });
    });
  }

  showLoadedSession(sessionId: string) {
    return this.showLoadedSessionTarget(sessionId, false);
  }

  private showLoadedSessionTarget(sessionId: string, acceptedProjectOpen: boolean) {
    const session = this.sessionRegistry.findSession(sessionId);
    // An identity-only registry entry must not replace the visible session.
    if (!session) return false;
    if (!acceptedProjectOpen) this.projectOpenStore.cancelPending();
    this.sessionRegistry.observationRetention.retain(sessionId);
    this.suspendEmbeddedEditor();
    this.projectOpenStore.activate(session.workspacePath);
    this.restoreSessionPresentation();
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    session.conversationSessionStore.composerStore.draftStore.requestFocus();
    return true;
  }

  private async acceptProjectOpen(result: ProjectOpenResult) {
    if (this.signal.aborted) return;
    this.commandPaneStore.dismiss();
    this.suspendEmbeddedEditor();
    if (result.kind === "new-session") {
      this.showTemporarySession(
        result.path,
        result.sessionId ?? crypto.randomUUID(),
        result.stagedSession,
        true,
      );
      return;
    }
    const targetSessionId =
      result.sessionId ??
      this.props.catalog.projectSessions(result.path).find((session) => !session.resolved)
        ?.sessionId;
    if (targetSessionId) await this.openSessionTarget(targetSessionId, true);
    else this.showTemporarySession(result.path, crypto.randomUUID(), true, true);
  }

  async openWorkspaceChanges() {
    if (!this.activeSession || !this.projectOpenStore.projectPath) return;
    this.commandPaneStore.dismiss();
    this.reviews.clearActiveThread();
    await this.embeddedEditorStore.showSourceControl();
  }

  async openReviewThread(threadId: string) {
    if (!this.activeSession || !this.projectOpenStore.projectPath) return;
    const thread = this.reviews.threads.find((item) => item.id === threadId);
    if (!thread || thread.anchor.view === "message") return;
    this.reviews.selectThread(thread.id);
    await this.openFileInIde({
      path: thread.anchor.path,
      range: {
        start: {
          line:
            (thread.anchor.start.newLine ??
              thread.anchor.start.oldLine ??
              thread.anchor.start.diffLine + 1) - 1,
          column: thread.anchor.start.column,
        },
        end: {
          line:
            (thread.anchor.end.newLine ??
              thread.anchor.end.oldLine ??
              thread.anchor.end.diffLine + 1) - 1,
          column: thread.anchor.end.column,
        },
      },
    });
  }

  async openIde() {
    if (!this.activeSession || !this.projectOpenStore.projectPath) return;
    this.commandPaneStore.dismiss();
    this.reviews.clearActiveThread();
    await this.embeddedEditorStore.show();
  }

  /** Toggles the active Project Session between Agent and IDE presentation. */
  async toggleIde() {
    if (this.embeddedEditorStore.visible) {
      this.backToAgent();
      return;
    }
    await this.openIde();
  }

  async openFileInIde(location: SourceLocation) {
    if (!this.activeSession || !this.projectOpenStore.projectPath) return;
    this.commandPaneStore.dismiss();
    await this.embeddedEditorStore.show(location);
  }

  dismissSecondarySurfaces() {
    this.sessionContinuationStore.cancelPrompt();
    this.commandPaneStore.dismiss();
    this.suspendEmbeddedEditor();
  }

  sessionContext() {
    if (!this.projectOpenStore.projectPath || !this.session) return undefined;
    const summary = this.props.catalog.find(this.session.sessionId);
    const managedWorktree = this.props.catalog.managedWorktree(this.projectOpenStore.projectPath);
    return {
      workspacePath: this.projectOpenStore.projectPath,
      projectPath:
        summary?.projectPath ??
        managedWorktree?.projectPath ??
        this.props.catalog.projectOfManagedWorktree(this.projectOpenStore.projectPath) ??
        this.projectOpenStore.projectPath,
      sessionId: this.session.sessionId,
      canBranchFromCurrentWorktree:
        managedWorktree !== undefined &&
        ["active", "landed"].includes(managedWorktree.state ?? "active"),
    };
  }

  async restartPi() {
    if (!this.projectOpenStore.projectPath) return;
    try {
      await this.client.workspaces.restartPi(this.projectOpenStore.projectPath, {
        signal: this.signal,
      });
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async abortSession(sessionId: string) {
    const operationId = this.startOperation();
    try {
      await this.client.projectSessions.abort({ sessionId }, { signal: this.signal });
      this.finishOperation(operationId);
    } catch (error) {
      if (this.signal.aborted) return;
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  isActiveSession(sessionId: string) {
    return this.activeSessionId === sessionId;
  }

  receive(event: StoreEvent) {
    this.projectOpenStore.receive(event);
    if (
      event.type === "embedded-editor-selection" ||
      event.type === "embedded-editor-selection-cleared"
    ) {
      this.embeddedEditorStore.receive(event);
      if (event.workspacePath === this.projectOpenStore.projectPath)
        this.activeSession?.conversationSessionStore.composerStore.draftStore.setEditorContextAttachment(
          this.embeddedEditorStore.visible
            ? this.embeddedEditorStore.activeContextAttachment
            : undefined,
        );
      return;
    }
    if (event.type === "embedded-editor-back-to-agent") {
      if (event.workspacePath === this.projectOpenStore.projectPath) this.backToAgent();
      return;
    }
    if (event.type === "embedded-editor-annotation-opened") {
      if (
        event.workspacePath === this.projectOpenStore.projectPath &&
        event.sessionId === this.activeSessionId &&
        this.reviews.trySelectThread(event.threadId)
      ) {
        this.reviews.cancelDraft();
        this.embeddedEditorStore.showChatSidebar();
      }
      return;
    }
    if (event.type === "embedded-editor-toggle-chat") {
      if (event.workspacePath === this.projectOpenStore.projectPath)
        this.embeddedEditorStore.toggleChatSidebar();
      return;
    }
    if (event.type === "embedded-editor-toggle-sidebar") {
      if (event.workspacePath === this.projectOpenStore.projectPath)
        this.props.toggleProjectSidebar();
      return;
    }
    if (event.type === "embedded-editor-entered") {
      if (event.workspacePath === this.projectOpenStore.projectPath)
        this.embeddedEditorStore.showAgentEditor();
      return;
    }
    if (event.type === "agent-availability-changed") {
      if (
        event.workingDirectory &&
        event.workingDirectory !== this.projectOpenStore.projectPath &&
        event.workingDirectory !== this.projectOpenStore.pendingAuthorizationPath
      )
        return;
      this.agentAvailability = event.availability.state;
      this.agentAvailabilityReason = event.availability.reason;
      if (event.availability.state === "unavailable") {
        this.sessionOpenRevision += 1;
        this.reopenAfterAgentRestart = Boolean(
          this.projectOpenStore.projectPath &&
          this.session &&
          !this.sessionRegistry.pendingSessions.isTemporary(this.session.sessionId),
        );
        this.projectOpenStore.cancelPending();
        this.props.operations.reset();
        this.sessionContinuationStore.reset();
      }
      if (
        event.availability.state === "available" &&
        this.reopenAfterAgentRestart &&
        this.projectOpenStore.projectPath &&
        this.session
      ) {
        this.reopenAfterAgentRestart = false;
        void this.projectOpenStore.inspectPath(this.projectOpenStore.projectPath, {
          sessionId: this.session.sessionId,
        });
      }
      return;
    }
    if (event.type === "artifact-requested") return;
    if (event.type === "changelog-received") {
      return;
    }
    if (event.type === "ui-requested") return;
    if (event.type === "operation-completed") {
      if (this.activeOperations.includes(event.operationId)) {
        this.finishOperation(event.operationId);
      }
      return;
    }
    if (event.type === "operation-failed") {
      if (!event.operationId || !this.activeOperations.includes(event.operationId)) return;
      this.finishOperation(event.operationId);
      this.error = event.message;
      this.errorDetails = event.details ?? event.message;
      this.errorSessionId = this.activeSessionId;
    }
  }

  applyAgentAvailability(snapshot: AgentAvailabilitySnapshot) {
    const workingDirectory =
      this.projectOpenStore.projectPath ?? this.projectOpenStore.pendingAuthorizationPath;
    const availability =
      snapshot.workingDirectories.find((entry) => entry.workingDirectory === workingDirectory)
        ?.availability ?? snapshot.global;
    const event = {
      type: "agent-availability-changed",
      availability,
      ...(workingDirectory ? { workingDirectory } : null),
    } as const;
    this.extensionUi.receive(event);
    this.activeSession?.receive(event);
    this.receive(event);
  }
}
