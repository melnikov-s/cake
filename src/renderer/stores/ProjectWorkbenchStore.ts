import { Store, child, createStore } from "r-state-tree";
import type { SourceLocation } from "../../ipc/source-location";
import type {
  ApplicationState,
  ChatConfiguration,
  GlobalSessionSummary,
  SessionSnapshot,
  WindowViewState,
} from "../../ipc/session-contract";
import { reviewThreadAnnotations } from "../../utils/review-thread-annotations";
import type { DesktopClient, DesktopClientEvent, PiState } from "../desktop-client";
import { EmbeddedEditorStore, type EmbeddedEditorStoreProps } from "./EmbeddedEditorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { ExtensionUiStore } from "./ExtensionUiStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { WindowPersistenceCoordinatorStore } from "./WindowPersistenceCoordinatorStore";
import { describeError } from "../error-details";
import { CommandPaneStore, type CommandPaneStoreProps } from "./CommandPaneStore";
import { SessionManagementStore, type SessionManagementStoreProps } from "./SessionManagementStore";
import {
  SessionContinuationStore,
  type SessionContinuationStoreProps,
} from "./SessionContinuationStore";
import {
  WorktreeCreationStore,
  type WorktreeCreationStoreProps,
  type WorktreeDraftChoice,
} from "./WorktreeCreationStore";

export interface ProjectWorkbenchStoreProps {
  client: Pick<
    DesktopClient,
    | "abort"
    | "chooseProject"
    | "discardWorktree"
    | "getHomeDirectory"
    | "inspectWorkspace"
    | "listSessions"
    | "loadSession"
    | "openWorkspace"
    | "registerProject"
    | "removeProject"
    | "renameProject"
    | "respondToWorkspaceTrust"
    | "restartPi"
  >;
  commandPaneClient: CommandPaneStoreProps["client"];
  embeddedEditorClient: EmbeddedEditorStoreProps["client"];
  sessionContinuationClient: SessionContinuationStoreProps["client"];
  sessionManagementClient: SessionManagementStoreProps["client"];
  worktreeCreationClient: WorktreeCreationStoreProps["client"];
  sessionRegistry: SessionRegistryStore;
  operations: SessionOperationCoordinatorStore;
  projects: ProjectCatalogStore;
  defaultConfiguration?(): ChatConfiguration | undefined;
  reviews(): ReviewsStore;
  extensionUi(): ExtensionUiStore;
  pluginCommands(): PluginCommandStore;
  persistence(): WindowPersistenceCoordinatorStore;
  catalog: SessionCatalogStore;
  startCakeChat(prompt?: string): Promise<void>;
  /** Removes resolved worktree sessions from history and chooses the next conversation. */
  onWorktreeSessionsResolved(sessionIds: readonly string[], projectPath: string): Promise<void>;
  /** Navigates the shell to an existing session by ID. */
  openSessionById(sessionId: string): Promise<void>;
}

/** Owns active project/session activation and the project workbench workflow. */
export class ProjectWorkbenchStore extends Store<ProjectWorkbenchStoreProps> {
  readonly process = "renderer" as const;
  piState: PiState = "starting";
  projectPath: string | undefined;
  selectedSessionId: string | undefined;
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
      client: this.props.embeddedEditorClient,
      projectPath: () => this.projectPath,
      annotations: () => {
        const sessionId = this.selectedSessionId;
        if (!sessionId) return undefined;
        return reviewThreadAnnotations(
          sessionId,
          this.reviews.codeThreadsForSession(sessionId),
          (threadId) => this.reviews.threadStreaming(threadId),
        );
      },
      startCakeChat: (prompt) => this.props.startCakeChat(prompt),
    });
  }

  @child
  get commandPaneStore(): CommandPaneStore {
    return createStore(CommandPaneStore, {
      client: this.props.commandPaneClient,
      operations: this.props.operations,
      sessionContext: () => this.sessionContext(),
      editorText: (entryId) => this.session?.tree.find((entry) => entry.id === entryId)?.editorText,
      setDraft: (value) => this.activeSession?.chatStore.setDraft(value),
      requestComposerFocus: () => this.activeSession?.composerStore.requestFocus(),
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get sessionManagementStore(): SessionManagementStore {
    return createStore(SessionManagementStore, {
      client: this.props.sessionManagementClient,
      operations: this.props.operations,
      catalog: this.props.catalog,
      registry: this.sessionRegistry,
      applyApplicationState: (state) => this.applyApplicationState(state),
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get sessionContinuationStore(): SessionContinuationStore {
    return createStore(SessionContinuationStore, {
      client: this.props.sessionContinuationClient,
      operations: this.props.operations,
      registry: this.sessionRegistry,
      createWorktree: async (workspacePath, name) => {
        const projectPath =
          this.props.catalog.projectOfManagedWorktree(workspacePath) ?? workspacePath;
        const record = await this.worktreeCreationStore.create(projectPath, {
          name,
          baseWorktreePath: projectPath === workspacePath ? undefined : workspacePath,
        });
        return record.worktreePath;
      },
      sessionContext: () => this.sessionContext(),
      sessionTitle: () => this.sessionTitle,
      closeCommandPane: () => this.commandPaneStore.close(),
      openSession: (sessionId) => this.props.openSessionById(sessionId),
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get worktreeCreationStore(): WorktreeCreationStore {
    return createStore(WorktreeCreationStore, {
      client: this.props.worktreeCreationClient,
      operations: this.props.operations,
      catalog: this.props.catalog,
      relocateTemporarySession: (sessionId, workspacePath) => {
        this.sessionRegistry.relocateTemporarySession(sessionId, workspacePath);
        if (this.selectedSessionId === sessionId) this.projectPath = workspacePath;
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

  get client() {
    return this.props.client;
  }

  get sessionRegistry() {
    return this.props.sessionRegistry;
  }

  get activeSession() {
    return this.selectedSessionId
      ? this.sessionRegistry.findSession(this.selectedSessionId)
      : undefined;
  }

  get session() {
    return this.activeSession?.model;
  }

  /** False for a staged or explicit draft session; Pi lists it only after activation. */
  get activeSessionExists(): boolean {
    const sessionId = this.selectedSessionId;
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
    const local =
      command === "/tree" ||
      command === "/resources" ||
      command === "/changelog" ||
      this.props.pluginCommands().matches(session.chatStore.draft);
    return local || this.piState === "ready";
  }

  get pluginCommands() {
    return this.props.pluginCommands().commands;
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

  private applyApplicationState(state: ApplicationState) {
    this.props.projects.applyApplicationState(state);
  }

  async restoreSelection(state: WindowViewState, sessions: readonly GlobalSessionSummary[]) {
    const selectedSession = state.selectedSessionId
      ? sessions.find((session) => session.id === state.selectedSessionId)
      : undefined;
    const projectPath = selectedSession?.workspacePath ?? state.projectPath;
    this.projectPath = projectPath;
    if (!projectPath) return;
    if (
      state.selectedSessionId &&
      this.sessionRegistry.isTemporarySession(state.selectedSessionId) &&
      this.showCachedSession(state.selectedSessionId)
    )
      return;
    if (selectedSession?.resolved) {
      await this.openResolvedSessionPreview(selectedSession.id);
      return;
    }
    await this.inspectPath(
      projectPath,
      Boolean(state.selectedSessionId && !selectedSession),
      selectedSession?.id,
    );
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

  setError(error: unknown, context?: string) {
    const described = describeError(error, context);
    this.error = described.message;
    this.errorDetails = described.details;
    this.errorSessionId = this.selectedSessionId;
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

  /** Repeated picker requests are latest-wins. */
  async chooseProject() {
    const revision = ++this.projectPickerRevision;
    try {
      const path = await this.client.chooseProject();
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
      const path = await this.client.getHomeDirectory();
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
      const state = await this.client.renameProject(path, name);
      if (!this.signal.aborted) this.applyApplicationState(state);
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async removeProject(path: string, deleteSessions: boolean) {
    try {
      const state = await this.client.removeProject(path, deleteSessions);
      if (this.signal.aborted) return false;
      this.applyApplicationState(state);
      if (this.projectPath === path) {
        this.projectPath = undefined;
        this.selectedSessionId = undefined;
      }
      this.props.persistence().schedule();
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
        await this.client.discardWorktree({
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
    const submitted = await this.sessionRegistry
      .ensure(sessionId)
      .chatStore.submit(initialPrompt, { renderUserMessageAsMarkdown });
    if (!submitted) throw new Error("Cake could not submit the new session's initial prompt.");
    return sessionId;
  }

  configureDraftActivation(sessionId: string, choice: WorktreeDraftChoice) {
    this.worktreeCreationStore.select(sessionId, choice);
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
      .filter((session) => session.workspacePath === workspacePath && !session.resolved)
      .map((session) => session.id);
    if (sessionIds.length > 0)
      await this.sessionManagementStore.resolveSessionsById(sessionIds, true, workspacePath);
    await this.props.onWorktreeSessionsResolved(sessionIds, projectPath);
  }

  private closeEmbeddedEditor() {
    this.activeSession?.composerStore.setEditorContextAttachment(undefined);
    this.embeddedEditorStore.close();
  }

  private showTemporarySession(path: string, sessionId: string, staged = false) {
    this.pendingOpen = undefined;
    const session = staged
      ? this.sessionRegistry.prepareStagedSession(path, sessionId)
      : this.sessionRegistry.prepareNewSession(path, sessionId);
    this.props.persistence().applySessionRestore(session, this.selectedSessionId);
    this.closeEmbeddedEditor();
    this.projectPath = path;
    this.selectedSessionId = sessionId;
    this.markSessionRead(sessionId);
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    this.props.persistence().schedule();
    session.composerStore.requestFocus();
    void this.refreshRegisteredProject(path);
  }

  async openSession(sessionId: string) {
    const summary = this.props.catalog.find(sessionId);
    const workspacePath =
      summary?.workspacePath ?? this.sessionRegistry.findSession(sessionId)?.workspacePath;
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    this.markSessionRead(sessionId);
    if (workspacePath === this.projectPath && sessionId === this.session?.sessionId) return;
    const sameWorkspace = workspacePath === this.projectPath;
    const cached = this.showCachedSession(sessionId);
    if (cached && this.sessionRegistry.isTemporarySession(sessionId)) return;
    if (summary?.resolved) {
      await this.openResolvedSessionPreview(sessionId);
      return;
    }
    if (!cached) void this.loadSessionPreview(sessionId);
    if (sameWorkspace) await this.openPath(workspacePath, false, sessionId);
    else await this.inspectPath(workspacePath, false, sessionId);
  }

  /** Resolved transcripts remain archived and read-only until the user submits a prompt. */
  private async openResolvedSessionPreview(sessionId: string) {
    const revision = ++this.openRevision;
    this.pendingOpen = undefined;
    try {
      const preview = await this.client.loadSession(sessionId);
      if (!preview || this.signal.aborted || revision !== this.openRevision) return;
      this.sessionRegistry.hydratePreview(preview);
      this.showCachedSession(sessionId);
    } catch (error) {
      if (!this.signal.aborted && revision === this.openRevision)
        this.setError(error, "Opening resolved session");
    }
  }

  private async loadSessionPreview(sessionId: string) {
    try {
      const preview = await this.client.loadSession(sessionId);
      if (!preview || this.signal.aborted) return;
      const pendingMatches = this.pendingOpen?.sessionId === sessionId;
      const activeMatches = this.activeOpenTarget?.sessionId === sessionId;
      if (!pendingMatches && !activeMatches) return;
      this.sessionRegistry.hydratePreview(preview);
      this.showCachedSession(sessionId);
    } catch {
      // Runtime activation remains authoritative when the fast disk preview is unavailable.
    }
  }

  private showCachedSession(sessionId: string) {
    const session = this.sessionRegistry.findSession(sessionId);
    // An identity-only registry entry must not replace the visible session.
    if (!session || !session.hydrated) return false;
    this.closeEmbeddedEditor();
    this.projectPath = session.workspacePath;
    this.selectedSessionId = sessionId;
    this.markSessionRead(sessionId);
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    this.props.persistence().schedule();
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
      await this.client.inspectWorkspace({ operationId, path });
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
      await this.client.respondToWorkspaceTrust({
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
    if (this.signal.aborted || revision !== this.openRevision) return;
    const operationId = this.startOperation();
    this.activeOpenOperationId = operationId;
    this.activeOpenTarget = { path, sessionId, newSession };
    this.activeOpenExpectsEmpty = newSession;
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    this.closeEmbeddedEditor();
    try {
      await this.client.openWorkspace({
        operationId,
        path,
        newSession,
        sessionId,
        configuration: newSession ? this.props.defaultConfiguration?.() : undefined,
      });
      if (this.signal.aborted || revision !== this.openRevision) return;
      void this.refreshRegisteredProject(path, revision);
    } catch (error) {
      if (this.signal.aborted) return;
      if (revision === this.openRevision) this.setError(error);
      if (this.activeOpenOperationId === operationId) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      this.finishOperation(operationId);
    }
  }

  private async refreshRegisteredProject(path: string, openRevision?: number) {
    const shouldRefreshSessions = !this.props.projects.find(path);
    try {
      const state = await this.client.registerProject(path, this.props.projects.nameFromPath(path));
      if (this.signal.aborted || (openRevision !== undefined && openRevision !== this.openRevision))
        return;
      this.applyApplicationState(state);
      if (!shouldRefreshSessions) return;
      const sessionIndex = await this.client.listSessions();
      if (this.signal.aborted || (openRevision !== undefined && openRevision !== this.openRevision))
        return;
      const listedIds = new Set(sessionIndex.sessions.map((session) => session.id));
      const retainedProjectSessions = this.props.catalog
        .projectSessions(path)
        .filter((session) => !listedIds.has(session.id));
      this.props.catalog.replace([...sessionIndex.sessions, ...retainedProjectSessions]);
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

  async openFileInIde(location: SourceLocation) {
    if (!this.activeSession || !this.projectPath) return;
    this.commandPaneStore.dismiss();
    await this.embeddedEditorStore.show(location);
  }

  dismissSecondarySurfaces() {
    this.sessionContinuationStore.cancelPrompt();
    this.commandPaneStore.dismiss();
    this.closeEmbeddedEditor();
  }

  sessionContext() {
    if (!this.projectPath || !this.session) return undefined;
    return { workspacePath: this.projectPath, sessionId: this.session.sessionId };
  }

  openingSession(sessionId: string) {
    return this.activeOpenTarget?.sessionId === sessionId;
  }

  async restartPi() {
    if (!this.projectPath) return;
    try {
      await this.client.restartPi(this.projectPath);
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async abort() {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext();
      if (!context) throw new Error("No active session");
      await this.client.abort({ operationId, sessionId: context.sessionId });
    } catch (error) {
      if (this.signal.aborted) return;
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  applySessionSnapshot(
    snapshot: SessionSnapshot,
    previousSessionId?: string,
    focusComposer = false,
  ) {
    const restartDraft = this.draftAfterAgentRestart;
    this.projectPath = snapshot.workspacePath;
    this.selectedSessionId = snapshot.sessionId;
    const activeSession = this.sessionRegistry.ensure(snapshot.sessionId);
    this.markSessionRead(snapshot.sessionId);
    this.props.persistence().applySessionRestore(activeSession, previousSessionId, restartDraft);
    this.draftAfterAgentRestart = undefined;
    if (previousSessionId !== undefined) this.extensionUi.clear();
    this.extensionUi.applyState(snapshot.extensionUi);
    this.pendingOpen = undefined;
    const workspaceName = this.props.projects.nameForPath(snapshot.workspacePath);
    this.props.catalog.applyWorkspace(
      snapshot.workspacePath,
      workspaceName,
      snapshot.sessions,
      this.sessionRegistry.retainedNewSessionIds(snapshot.workspacePath),
    );
    this.props.projects.recordOpened(
      this.props.catalog.projectOfManagedWorktree(snapshot.workspacePath) ?? snapshot.workspacePath,
    );
    this.props.persistence().schedule();
    void this.reviews.loadThreads(snapshot.sessionId);
    if (focusComposer) activeSession.composerStore.requestFocus();
  }

  isActiveSession(sessionId: string) {
    return this.selectedSessionId === sessionId;
  }

  acceptSessionSnapshot(event: Extract<DesktopClientEvent, { type: "session-snapshot-received" }>) {
    if (event.operationId) {
      if (this.sessionContinuationStore.acceptSnapshotOperation(event.operationId)) return true;
      if (event.operationId !== this.activeOpenOperationId) {
        this.finishOperation(event.operationId);
        return false;
      }
      if (
        this.activeOpenTarget?.newSession &&
        this.activeOpenTarget.sessionId &&
        this.activeOpenTarget.sessionId !== event.snapshot.sessionId
      ) {
        this.sessionRegistry.removeSession(this.activeOpenTarget.sessionId);
      }
      if (this.activeOpenExpectsEmpty && event.snapshot.parts.length > 0) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
        this.finishOperation(event.operationId);
        this.setError("Cake refused to mount history in a newly created session");
        return false;
      }
      this.activeOpenOperationId = undefined;
      this.activeOpenTarget = undefined;
      this.activeOpenExpectsEmpty = false;
    } else if (!this.session || event.snapshot.sessionId !== this.session.sessionId) {
      return false;
    }
    if (event.operationId) this.finishOperation(event.operationId);
    return true;
  }

  receive(event: DesktopClientEvent) {
    if (
      event.type === "embedded-editor-state-received" ||
      event.type === "embedded-editor-selection" ||
      event.type === "embedded-editor-selection-cleared"
    ) {
      this.embeddedEditorStore.receive(event);
      if (
        event.type !== "embedded-editor-state-received" &&
        event.workspacePath === this.projectPath
      )
        this.activeSession?.composerStore.setEditorContextAttachment(
          this.embeddedEditorStore.visible
            ? this.embeddedEditorStore.activeContextAttachment
            : undefined,
        );
      return;
    }
    if (event.type === "embedded-editor-back-to-agent") {
      if (event.workspacePath === this.projectPath) {
        this.closeEmbeddedEditor();
        this.activeSession?.composerStore.requestFocus();
      }
      return;
    }
    if (event.type === "embedded-editor-annotation-opened") {
      if (
        event.workspacePath === this.projectPath &&
        event.sessionId === this.selectedSessionId &&
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
    if (event.type === "embedded-editor-location-opened") {
      if (event.workspacePath === this.projectPath) this.embeddedEditorStore.showAgentLocation();
      return;
    }
    if (event.type === "pi-state-changed") {
      if (
        event.workspacePath &&
        event.workspacePath !== this.projectPath &&
        event.workspacePath !== this.pendingOpen?.path
      )
        return;
      this.piState = event.state;
      if (event.state === "failed" || event.state === "stopped") {
        this.commandPaneStore.receive(event);
        this.reopenAfterAgentRestart = Boolean(
          this.projectPath &&
          this.session &&
          !this.sessionRegistry.isTemporarySession(this.session.sessionId),
        );
        if (this.reopenAfterAgentRestart)
          this.draftAfterAgentRestart = this.activeSession?.chatStore.draft;
        this.props.operations.reset();
        this.sessionManagementStore.receive(event);
        this.sessionContinuationStore.reset();
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      if (
        event.state === "ready" &&
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
      else void this.openPath(event.path, false, pending.sessionId);
      return;
    }
    if (
      event.type === "session-snapshot-received" ||
      event.type === "part-updated" ||
      event.type === "part-removed" ||
      event.type === "streaming-changed" ||
      event.type === "background-work-changed"
    )
      return;
    if (event.type === "artifact-updated") return;
    if (event.type === "review-threads-received") {
      return;
    }
    if (event.type === "review-thread-updated") {
      return;
    }
    if (event.type === "review-thread-streaming") return;
    if (event.type === "artifact-requested" || event.type === "extension-ui-received") return;
    if (event.type === "changelog-received") {
      this.commandPaneStore.receive(event);
      return;
    }
    if (event.type === "ui-requested") return;
    if (event.type === "operation-completed") {
      if (this.commandPaneStore.receive(event)) return;
      if (this.sessionContinuationStore.receive(event)) return;
      this.sessionManagementStore.receive(event);
      if (this.activeOperations.includes(event.operationId)) {
        this.finishOperation(event.operationId);
      }
      return;
    }
    if (event.type === "operation-failed") {
      if (this.commandPaneStore.receive(event)) return;
      this.sessionManagementStore.receive(event);
      if (this.sessionContinuationStore.receive(event)) return;
      if (!event.operationId || !this.activeOperations.includes(event.operationId)) return;
      this.finishOperation(event.operationId);
      if (event.operationId === this.activeOpenOperationId) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      this.error = event.message;
      this.errorDetails = event.details ?? event.message;
      this.errorSessionId = this.selectedSessionId;
    }
  }
}
