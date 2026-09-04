import { Store, child, createStore, snapshot } from "r-state-tree";
import type { SourceLocation } from "../../ipc/source-location";
import type { ChatConfiguration } from "../../ipc/session-contract";
import { reviewThreadAnnotations } from "../../utils/review-thread-annotations";
import type { RendererEvent } from "../RendererEvent";
import type {
  AgentAvailabilitySnapshot,
  AgentAvailabilityState,
} from "../../domain/agent-availability-data";
import { EmbeddedEditorStore } from "./EmbeddedEditorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { ExtensionUiStore } from "./ExtensionUiStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { describeError } from "../error-details";
import { RendererClientContext } from "../client/RendererClientContext";
import { CommandPaneStore } from "./CommandPaneStore";
import { SessionManagementStore, type SessionManagementStoreProps } from "./SessionManagementStore";
import { SessionContinuationStore } from "./SessionContinuationStore";
import { WorktreeCreationStore, type WorktreeDraftChoice } from "./WorktreeCreationStore";

export interface ProjectWorkbenchStoreProps {
  prepareSessionResolution?: SessionManagementStoreProps["prepareResolution"];
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
  /** Selects a Project Session in the application shell. */
  selectSession(sessionId: string): void;
  toggleProjectSidebar(): void;
  enterIdeSidebarMode(): void;
  leaveIdeSidebarMode(): void;
  projectSidebarWidth(): number;
}

/** Owns active project/session activation and the project workbench workflow. */
export class ProjectWorkbenchStore extends Store<ProjectWorkbenchStoreProps> {
  readonly process = "renderer" as const;

  get client() {
    return RendererClientContext.consume(this)!;
  }
  agentAvailability: AgentAvailabilityState = "available";
  agentAvailabilityReason: string | undefined;
  @snapshot projectPath: string | undefined;
  pendingTrustPath: string | undefined;
  private pendingOpen:
    | {
        inspectOperationId: string;
        path: string;
        newSession: boolean;
        stagedSession: boolean;
        sessionId?: string;
      }
    | undefined;
  private activeOpenOperationId: string | undefined;
  private activeOpenTarget: { path: string; sessionId?: string; newSession: boolean } | undefined;
  private activeOpenExpectsEmpty = false;
  error: string | undefined;
  errorDetails: string | undefined;
  /** Session context the current error belongs to; context-free errors are undefined. */
  private errorSessionId: string | undefined;
  private openRevision = 0;
  private projectPickerRevision = 0;
  private reopenAfterAgentRestart = false;
  private draftAfterAgentRestart: string | undefined;

  private get reviews() {
    return this.props.reviews();
  }
  private get extensionUi() {
    return this.props.extensionUi();
  }

  @child
  get embeddedEditorStore(): EmbeddedEditorStore {
    return createStore(EmbeddedEditorStore, {
      projectPath: () => this.projectPath,
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
      editorText: (entryId) => this.session?.tree.find((entry) => entry.id === entryId)?.editorText,
      setDraft: (value) => this.activeSession?.chatStore.setDraft(value),
      requestComposerFocus: () => this.activeSession?.composerStore.requestFocus(),
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get sessionManagementStore(): SessionManagementStore {
    return createStore(SessionManagementStore, {
      operations: this.props.operations,
      catalog: this.props.catalog,
      registry: this.sessionRegistry,
      prepareResolution: this.props.prepareSessionResolution,
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
        this.sessionRegistry.relocateTemporarySession(sessionId, workspacePath);
        if (this.activeSessionId === sessionId) this.projectPath = workspacePath;
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

  get pendingAuthorizationPath() {
    return this.pendingOpen?.path;
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
    return sessionId !== undefined && !this.sessionRegistry.isTemporarySession(sessionId);
  }

  get sessionTitle() {
    const context = this.sessionContext();
    const title = context ? this.props.catalog.find(context.sessionId)?.title : undefined;
    return title ?? "New chat";
  }

  canSubmitSession(sessionId: string) {
    if (!this.isActiveSession(sessionId) || this.activeOpenOperationId) return false;
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session) return false;
    if (this.sessionRegistry.isTemporarySession(sessionId)) return true;
    const command = session.chatStore.draft.trim().toLocaleLowerCase();
    const local = command === "/tree" || command === "/resources" || command === "/changelog";
    return local || this.agentAvailability === "available";
  }

  get projectName() {
    return this.projectPath ? this.props.projects.nameForPath(this.projectPath) : "No workspace";
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
      this.projectPath = selection.workspacePath;
      if (!this.sessionRegistry.findSession(selection.sessionId))
        this.sessionRegistry.load(selection.sessionId, selection.workspacePath);
      else this.sessionRegistry.retainObservation(selection.sessionId);
    }
    const path = this.projectPath;
    if (!path) return;
    const sessionId = this.activeSessionId;
    const temporary = sessionId ? this.sessionRegistry.isTemporarySession(sessionId) : true;
    await this.inspectPath(
      path,
      temporary,
      sessionId,
      temporary && sessionId !== undefined && !this.sessionRegistry.isDraftSession(sessionId),
    );
  }

  /** Repeated picker requests are latest-wins. */
  async chooseProject() {
    const revision = ++this.projectPickerRevision;
    try {
      const path = await this.client.electron.chooseProject({ signal: this.signal });
      if (path && !this.signal.aborted && revision === this.projectPickerRevision)
        await this.inspectPath(path);
    } catch (error) {
      if (!this.signal.aborted && revision === this.projectPickerRevision)
        this.setError(error, "Choosing a project folder");
    }
  }

  /** Repeated one-off requests are latest-wins. */
  async startOneOffChat() {
    const revision = ++this.projectPickerRevision;
    try {
      const path = await this.client.application.getHomeDirectory({ signal: this.signal });
      if (!this.signal.aborted && revision === this.projectPickerRevision)
        await this.inspectPath(path, true, undefined, true);
    } catch (error) {
      if (!this.signal.aborted && revision === this.projectPickerRevision) this.setError(error);
    }
  }

  async switchProject(path: string) {
    if (path === this.projectPath) return;
    try {
      await this.inspectPath(path);
    } catch (error) {
      this.setError(error, `Opening project ${path}`);
    }
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
      if (this.projectPath === path) {
        this.openRevision += 1;
        this.projectPath = undefined;
      }
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
      return false;
    }
  }

  async deleteResolvedWorktrees(path: string) {
    const records = this.props.catalog.resolvedWorktrees(path);
    try {
      for (const record of records) {
        await this.client.managedWorktrees.discard({
          operationId: crypto.randomUUID(),
          workspacePath: record.worktreePath,
          keepBranch: false,
        });
        if (this.signal.aborted) return false;
        this.props.catalog.noteManagedWorktree({ ...record, state: "discarded" });
      }
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.setError(error, "Deleting resolved worktrees");
      return false;
    }
  }

  async startNewSession(path = this.projectPath) {
    const staged = this.sessionRegistry.stagedSession();
    if (staged) {
      this.openRevision += 1;
      this.showCachedSession(staged.sessionId);
      return;
    }
    if (!path) {
      await this.chooseProject();
      return;
    }
    const sessionId = crypto.randomUUID();
    if (path === this.projectPath) this.showTemporarySession(path, sessionId, true);
    else await this.inspectPath(path, true, sessionId, true);
  }

  newSessionRequest(sessionId: string) {
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session || !this.sessionRegistry.isTemporarySession(sessionId)) return undefined;
    return {
      path: session.workspacePath,
      configuration:
        this.sessionRegistry.pendingConfiguration(sessionId) ?? this.props.defaultConfiguration?.(),
      name: this.sessionRegistry.pendingName(sessionId),
    };
  }

  /** Creates and saves a Cake-owned draft without starting a Pi Session. */
  async createDraftSession(
    path: string,
    name: string,
    initialPrompt: string,
    configuration?: ChatConfiguration,
  ) {
    const sessionId = crypto.randomUUID();
    this.showTemporarySession(path, sessionId);
    this.sessionRegistry.setPendingName(sessionId, name);
    if (configuration) this.sessionRegistry.setPendingConfiguration(sessionId, configuration);
    await this.sessionRegistry.createDraftSession(sessionId, initialPrompt, []);
    return sessionId;
  }

  /** Creates, names, and starts a session in a workspace Cake has already authorized. */
  async createSession(
    path: string,
    name: string,
    initialPrompt: string,
    configuration?: ChatConfiguration,
    renderUserMessageAsMarkdown = true,
  ) {
    const sessionId = crypto.randomUUID();
    this.showTemporarySession(path, sessionId);
    this.sessionRegistry.setPendingName(sessionId, name);
    if (configuration) this.sessionRegistry.setPendingConfiguration(sessionId, configuration);
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session) throw new Error("Cake could not prepare the new session.");
    const submitted = await session.chatStore.submit(initialPrompt, {
      renderUserMessageAsMarkdown,
    });
    if (!submitted) throw new Error("Cake could not submit the new session's initial prompt.");
    return sessionId;
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
    if (!session || !this.sessionRegistry.isTemporarySession(sessionId)) return true;
    const projectPath =
      this.props.catalog.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    return this.worktreeCreationStore.prepare(sessionId, projectPath, firstUserMessage);
  }

  async resolveWorktreeWorkspace(workspacePath: string) {
    const projectPath = this.props.catalog.projectOfManagedWorktree(workspacePath) ?? workspacePath;
    const sessionIds = this.props.catalog.sessions
      .filter((session) => session.workingDirectory === workspacePath && !session.resolved)
      .map((session) => session.sessionId);
    const resolvedCount =
      sessionIds.length > 0
        ? await this.sessionManagementStore.resolveSessionsById(sessionIds, true)
        : 0;
    if (resolvedCount === sessionIds.length)
      await this.props.onWorktreeSessionsResolved(sessionIds, projectPath);
  }

  private suspendEmbeddedEditor() {
    this.activeSession?.composerStore.setEditorContextAttachment(undefined);
    this.embeddedEditorStore.suspend();
  }

  /** Explicitly returns the active session to its Agent presentation. */
  backToAgent() {
    this.activeSession?.composerStore.setEditorContextAttachment(undefined);
    this.embeddedEditorStore.hide();
    this.activeSession?.composerStore.requestFocus();
  }

  restoreSessionPresentation() {
    if (this.activeSession?.ideMode) void this.embeddedEditorStore.restore();
  }

  private showTemporarySession(path: string, sessionId: string, staged = false) {
    this.openRevision += 1;
    this.pendingOpen = undefined;
    const session = staged
      ? this.sessionRegistry.prepareStagedSession(path, sessionId)
      : this.sessionRegistry.prepareNewSession(path, sessionId);
    this.suspendEmbeddedEditor();
    this.projectPath = path;
    this.props.selectSession(sessionId);
    this.markSessionRead(sessionId);
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    session.composerStore.requestFocus();
    void session.stagedCommandStore.load(path);
    void this.refreshRegisteredProject(path);
  }

  async openSession(sessionId: string) {
    const revision = ++this.openRevision;
    const summary = this.props.catalog.find(sessionId);
    const workspacePath =
      summary?.workingDirectory ?? this.sessionRegistry.findSession(sessionId)?.workspacePath;
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    const alreadyActive = this.activeSessionId === sessionId;
    this.props.selectSession(sessionId);
    this.error = undefined;
    this.errorDetails = undefined;
    this.errorSessionId = undefined;
    this.markSessionRead(sessionId);
    if (
      alreadyActive &&
      workspacePath === this.projectPath &&
      sessionId === this.session?.sessionId
    ) {
      this.restoreSessionPresentation();
      return;
    }
    const cached = this.showCachedSession(sessionId);
    if (cached && this.sessionRegistry.isTemporarySession(sessionId)) return;
    try {
      await this.client.projectSessions.open(
        { sessionId, workingDirectory: workspacePath },
        { signal: this.signal },
      );
      if (this.signal.aborted || revision !== this.openRevision) return;
      if (!cached) {
        this.sessionRegistry.load(sessionId, workspacePath);
        this.showCachedSession(sessionId);
      }
      this.props.projects.recordOpened(
        this.props.catalog.projectOfManagedWorktree(workspacePath) ?? workspacePath,
      );
    } catch (error) {
      if (!this.signal.aborted && revision === this.openRevision)
        this.setError(error, "Opening Project Session", sessionId);
    }
  }

  private showCachedSession(sessionId: string) {
    const session = this.sessionRegistry.findSession(sessionId);
    // An identity-only registry entry must not replace the visible session.
    if (!session) return false;
    this.sessionRegistry.retainObservation(sessionId);
    this.suspendEmbeddedEditor();
    this.projectPath = session.workspacePath;
    this.restoreSessionPresentation();
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    session.composerStore.requestFocus();
    return true;
  }

  private async inspectPath(
    path: string,
    newSession = false,
    sessionId?: string,
    stagedSession = false,
  ) {
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.extensionUi.clear();
    this.pendingTrustPath = undefined;
    this.pendingOpen = {
      inspectOperationId: operationId,
      path,
      newSession,
      stagedSession,
      sessionId,
    };
    try {
      await this.client.workspaces.inspect({ operationId, path }, { signal: this.signal });
    } catch (error) {
      if (revision === this.openRevision) this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async resolveProjectTrust(trusted: boolean) {
    const pending = this.pendingOpen;
    if (!pending || !this.pendingTrustPath) return;
    this.pendingTrustPath = undefined;
    try {
      await this.client.workspaces.respondToTrust({
        operationId: pending.inspectOperationId,
        path: pending.path,
        approved: trusted,
      });
    } catch (error) {
      if (this.signal.aborted || this.pendingOpen !== pending) return;
      this.pendingOpen = undefined;
      this.setError(error);
      return;
    }
    if (this.pendingOpen !== pending) return;
    if (!trusted) {
      this.pendingOpen = undefined;
      return;
    }
    if (pending.newSession)
      this.showTemporarySession(
        pending.path,
        pending.sessionId ?? crypto.randomUUID(),
        pending.stagedSession,
      );
    else await this.openPath(pending.path, false, pending.sessionId);
  }

  private async openPath(path: string, newSession = false, sessionId?: string) {
    const revision = ++this.openRevision;
    if (this.signal.aborted) return;
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    this.suspendEmbeddedEditor();
    await this.refreshRegisteredProject(path, revision);
    if (this.signal.aborted || revision !== this.openRevision) return;
    if (newSession) {
      this.showTemporarySession(path, sessionId ?? crypto.randomUUID());
      return;
    }
    const targetSessionId =
      sessionId ??
      this.props.catalog.projectSessions(path).find((session) => !session.resolved)?.sessionId;
    if (targetSessionId) await this.openSession(targetSessionId);
    else this.showTemporarySession(path, crypto.randomUUID(), true);
  }

  private async refreshRegisteredProject(path: string, openRevision?: number) {
    try {
      await this.client.workspaces.registerProject(path, this.props.projects.nameFromPath(path), {
        signal: this.signal,
      });
      if (this.signal.aborted || (openRevision !== undefined && openRevision !== this.openRevision))
        return;
    } catch (error) {
      if (
        !this.signal.aborted &&
        (openRevision === undefined || openRevision === this.openRevision)
      )
        this.setError(error);
    }
  }

  async openWorkspaceChanges() {
    if (!this.activeSession || !this.projectPath) return;
    this.commandPaneStore.dismiss();
    this.reviews.clearActiveThread();
    await this.embeddedEditorStore.showSourceControl();
  }

  async openReviewThread(threadId: string) {
    if (!this.activeSession || !this.projectPath) return;
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
    if (!this.activeSession || !this.projectPath) return;
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
    if (!this.activeSession || !this.projectPath) return;
    this.commandPaneStore.dismiss();
    await this.embeddedEditorStore.show(location);
  }

  dismissSecondarySurfaces() {
    this.sessionContinuationStore.cancelPrompt();
    this.commandPaneStore.dismiss();
    this.suspendEmbeddedEditor();
  }

  sessionContext() {
    if (!this.projectPath || !this.session) return undefined;
    const summary = this.props.catalog.find(this.session.sessionId);
    const managedWorktree = this.props.catalog.managedWorktree(this.projectPath);
    return {
      workspacePath: this.projectPath,
      projectPath:
        summary?.projectPath ??
        managedWorktree?.projectPath ??
        this.props.catalog.projectOfManagedWorktree(this.projectPath) ??
        this.projectPath,
      sessionId: this.session.sessionId,
      canBranchFromCurrentWorktree:
        managedWorktree !== undefined &&
        ["active", "landed"].includes(managedWorktree.state ?? "active"),
    };
  }

  openingSession(sessionId: string) {
    return this.activeOpenTarget?.sessionId === sessionId;
  }

  async restartPi() {
    if (!this.projectPath) return;
    try {
      await this.client.workspaces.restartPi(this.projectPath, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async abort() {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext();
      if (!context) throw new Error("No active session");
      await this.client.projectSessions.abort(
        { sessionId: context.sessionId },
        { signal: this.signal },
      );
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

  receive(event: RendererEvent) {
    if (
      event.type === "embedded-editor-selection" ||
      event.type === "embedded-editor-selection-cleared"
    ) {
      this.embeddedEditorStore.receive(event);
      if (event.workspacePath === this.projectPath)
        this.activeSession?.composerStore.setEditorContextAttachment(
          this.embeddedEditorStore.visible
            ? this.embeddedEditorStore.activeContextAttachment
            : undefined,
        );
      return;
    }
    if (event.type === "embedded-editor-back-to-agent") {
      if (event.workspacePath === this.projectPath) this.backToAgent();
      return;
    }
    if (event.type === "embedded-editor-annotation-opened") {
      if (
        event.workspacePath === this.projectPath &&
        event.sessionId === this.activeSessionId &&
        this.reviews.trySelectThread(event.threadId)
      ) {
        this.reviews.cancelDraft();
        this.embeddedEditorStore.showChatSidebar();
      }
      return;
    }
    if (event.type === "embedded-editor-toggle-chat") {
      if (event.workspacePath === this.projectPath) this.embeddedEditorStore.toggleChatSidebar();
      return;
    }
    if (event.type === "embedded-editor-toggle-sidebar") {
      if (event.workspacePath === this.projectPath) this.props.toggleProjectSidebar();
      return;
    }
    if (event.type === "embedded-editor-entered") {
      if (event.workspacePath === this.projectPath) this.embeddedEditorStore.showAgentEditor();
      return;
    }
    if (event.type === "agent-availability-changed") {
      if (
        event.workingDirectory &&
        event.workingDirectory !== this.projectPath &&
        event.workingDirectory !== this.pendingOpen?.path
      )
        return;
      this.agentAvailability = event.availability.state;
      this.agentAvailabilityReason = event.availability.reason;
      if (event.availability.state === "unavailable") {
        this.openRevision += 1;
        this.reopenAfterAgentRestart = Boolean(
          this.projectPath &&
          this.session &&
          !this.sessionRegistry.isTemporarySession(this.session.sessionId),
        );
        if (this.reopenAfterAgentRestart)
          this.draftAfterAgentRestart = this.activeSession?.chatStore.draft;
        this.props.operations.reset();
        this.sessionContinuationStore.reset();
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      if (
        event.availability.state === "available" &&
        this.reopenAfterAgentRestart &&
        this.projectPath &&
        this.session
      ) {
        this.reopenAfterAgentRestart = false;
        void this.inspectPath(this.projectPath, false, this.session.sessionId);
      }
      return;
    }
    if (event.type === "workspace-inspected") {
      this.finishOperation(event.operationId);
      const pending = this.pendingOpen;
      if (!pending || pending.inspectOperationId !== event.operationId) return;
      if (event.trustRequired) this.pendingTrustPath = event.path;
      else if (pending.newSession)
        this.showTemporarySession(
          event.path,
          pending.sessionId ?? crypto.randomUUID(),
          pending.stagedSession,
        );
      else {
        this.pendingOpen = undefined;
        void this.openPath(event.path, false, pending.sessionId);
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
      if (event.operationId === this.activeOpenOperationId) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      this.error = event.message;
      this.errorDetails = event.details ?? event.message;
      this.errorSessionId = this.activeSessionId;
    }
  }

  applyAgentAvailability(snapshot: AgentAvailabilitySnapshot) {
    const workingDirectory = this.projectPath ?? this.pendingOpen?.path;
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
