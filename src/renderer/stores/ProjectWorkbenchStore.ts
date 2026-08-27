import { Store, child, createStore } from "r-state-tree";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { SourceLocation } from "../../ipc/source-location";
import type {
  ApplicationState,
  ChatConfiguration,
  GlobalSessionSummary,
  SessionSnapshot,
  WindowViewState,
} from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent, PiState } from "../desktop-client";
import { ChangesStore, type ChangesStoreProps } from "./ChangesStore";
import { EmbeddedEditorStore, type EmbeddedEditorStoreProps } from "./EmbeddedEditorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { ExtensionUiStore } from "./ExtensionUiStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { WindowPersistenceCoordinatorStore } from "./WindowPersistenceCoordinatorStore";
import { WorktreeStore, type WorktreeStoreProps } from "./WorktreeStore";
import { describeError } from "../error-details";
import { CommandPaneStore, type CommandPaneStoreProps } from "./CommandPaneStore";
import { SessionManagementStore, type SessionManagementStoreProps } from "./SessionManagementStore";
import { SessionForkStore, type SessionForkStoreProps } from "./SessionForkStore";
import { WorktreeCreationStore, type WorktreeCreationStoreProps } from "./WorktreeCreationStore";

export interface ProjectWorkbenchStoreProps {
  client: Pick<
    DesktopClient,
    | "abort"
    | "chooseProject"
    | "getHomeDirectory"
    | "inspectWorkspace"
    | "loadSession"
    | "openWorkspace"
    | "registerProject"
    | "removeProject"
    | "renameProject"
    | "respondToWorkspaceTrust"
    | "restartPi"
  >;
  changesClient: ChangesStoreProps["client"];
  commandPaneClient: CommandPaneStoreProps["client"];
  embeddedEditorClient: EmbeddedEditorStoreProps["client"];
  sessionForkClient: SessionForkStoreProps["client"];
  sessionManagementClient: SessionManagementStoreProps["client"];
  worktreeClient: WorktreeStoreProps["client"];
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
  /** Leaves the current surface and opens a fresh session in the given project. */
  startFreshSessionInProject(path: string): Promise<void>;
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
    | { inspectOperationId: string; path: string; newSession: boolean; sessionId?: string }
    | undefined;
  private activeOpenOperationId: string | undefined;
  private activeOpenTarget: { path: string; sessionId?: string; newSession: boolean } | undefined;
  private activeOpenExpectsEmpty = false;
  error: string | undefined;
  errorDetails: string | undefined;
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
      parts: () => this.activeSession?.canonicalParts ?? [],
      startCakeChat: (prompt) => this.props.startCakeChat(prompt),
    });
  }

  @child
  get changesStore(): ChangesStore {
    return createStore(ChangesStore, {
      client: this.props.changesClient,
      projectPath: () => this.projectPath,
      sessionId: () => this.session?.sessionId,
      parts: () => this.activeSession?.canonicalParts ?? [],
      operations: this.props.operations,
    });
  }

  @child
  get worktreeStore(): WorktreeStore {
    return createStore(WorktreeStore, {
      client: this.props.worktreeClient,
      workspacePath: () =>
        this.selectedSessionId ? (this.session?.workspacePath ?? this.projectPath) : undefined,
      sessionId: () => this.selectedSessionId,
      isStreaming: () => this.activeSession?.isStreaming ?? false,
      onLanded: (projectPath) => {
        void this.props.startFreshSessionInProject(projectPath);
      },
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
      applyApplicationState: (state) => this.applyApplicationState(state),
      reportError: (error) => this.setError(error),
    });
  }

  @child
  get sessionForkStore(): SessionForkStore {
    return createStore(SessionForkStore, {
      client: this.props.sessionForkClient,
      operations: this.props.operations,
      registry: this.sessionRegistry,
      sessionContext: () => this.sessionContext(),
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
      openCreatedWorktree: async (worktreePath, projectPath) => {
        const sessionId = crypto.randomUUID();
        if (projectPath === this.projectPath) this.showTemporarySession(worktreePath, sessionId);
        else await this.inspectPath(worktreePath, true, sessionId);
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

  /** False for a pending draft session; Pi only lists it after its first prompt. */
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
        await this.inspectPath(path, true);
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

  async removeProject(path: string) {
    try {
      const state = await this.client.removeProject(path);
      if (this.signal.aborted) return;
      this.applyApplicationState(state);
      if (this.projectPath === path) {
        this.projectPath = undefined;
        this.selectedSessionId = undefined;
      }
      this.props.persistence().schedule();
    } catch (error) {
      if (!this.signal.aborted) this.setError(error);
    }
  }

  async startNewSession(path = this.projectPath) {
    if (!path) {
      await this.chooseProject();
      return;
    }
    // Pi does not list an empty session until its first prompt. Keep one pending
    // session per project so returning through the project + action reopens its draft.
    const pending = this.sessionRegistry.pendingNewSession(path);
    if (pending) {
      if (path === this.projectPath && pending.sessionId === this.session?.sessionId) {
        pending.composerStore.requestFocus();
        return;
      }
      if (this.sessionRegistry.isTemporarySession(pending.sessionId)) {
        this.showCachedSession(pending.sessionId);
        return;
      }
      await this.openSession(pending.sessionId);
      return;
    }
    const sessionId = crypto.randomUUID();
    if (path === this.projectPath) this.showTemporarySession(path, sessionId);
    else await this.inspectPath(path, true, sessionId);
  }

  newSessionRequest(sessionId: string) {
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session || !this.sessionRegistry.isTemporarySession(sessionId)) return undefined;
    return {
      path: session.workspacePath,
      configuration:
        this.sessionRegistry.pendingConfiguration(sessionId) ?? this.props.defaultConfiguration?.(),
    };
  }

  private closeEmbeddedEditor() {
    this.activeSession?.composerStore.setEditorContextAttachment(undefined);
    this.embeddedEditorStore.close();
  }

  private showTemporarySession(path: string, sessionId: string) {
    this.pendingOpen = undefined;
    const session = this.sessionRegistry.prepareNewSession(path, sessionId);
    this.props.persistence().applySessionRestore(session, this.selectedSessionId, undefined, true);
    this.closeEmbeddedEditor();
    this.projectPath = path;
    this.selectedSessionId = sessionId;
    this.markSessionRead(sessionId);
    this.extensionUi.clear();
    this.commandPaneStore.dismiss();
    this.changesStore.reset();
    this.props.persistence().schedule();
    session.composerStore.requestFocus();
    void this.client
      .registerProject(path, this.props.projects.nameFromPath(path))
      .then((state) => {
        if (!this.signal.aborted) this.applyApplicationState(state);
      })
      .catch((error) => {
        if (!this.signal.aborted) this.setError(error);
      });
  }

  async openSession(sessionId: string) {
    const workspacePath =
      this.props.catalog.find(sessionId)?.workspacePath ??
      this.sessionRegistry.findSession(sessionId)?.workspacePath;
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    this.markSessionRead(sessionId);
    if (workspacePath === this.projectPath && sessionId === this.session?.sessionId) return;
    const sameWorkspace = workspacePath === this.projectPath;
    const cached = this.showCachedSession(sessionId);
    if (!cached) void this.loadSessionPreview(sessionId);
    if (sameWorkspace) await this.openPath(workspacePath, false, sessionId);
    else await this.inspectPath(workspacePath, false, sessionId);
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
    this.changesStore.reset();
    this.props.persistence().schedule();
    session.composerStore.requestFocus();
    return true;
  }

  private async inspectPath(path: string, newSession = false, sessionId?: string) {
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.extensionUi.clear();
    this.pendingTrustPath = undefined;
    this.pendingOpen = { inspectOperationId: operationId, path, newSession, sessionId };
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
      this.showTemporarySession(pending.path, pending.sessionId ?? crypto.randomUUID());
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
    this.changesStore.reset();
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
      void this.client
        .registerProject(path, this.props.projects.nameFromPath(path))
        .then((state) => {
          if (!this.signal.aborted && revision === this.openRevision)
            this.applyApplicationState(state);
        })
        .catch((error) => {
          if (!this.signal.aborted && revision === this.openRevision) this.setError(error);
        });
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

  async openSessionChanges(threadId?: string) {
    if (!this.activeSessionExists) return;
    this.commandPaneStore.dismiss();
    const thread = threadId
      ? this.reviews.threads.find((item) => item.id === threadId)
      : this.reviews.openThreads.find((item) => item.anchor.view !== "file");
    if (thread?.anchor.view === "file") {
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
      return;
    }
    this.closeEmbeddedEditor();
    if (thread) this.reviews.selectThread(thread.id);
    else this.reviews.clearActiveThread();
    await this.changesStore.open(thread?.anchor.path);
  }

  async openIde() {
    if (!this.activeSession || !this.projectPath) return;
    this.commandPaneStore.dismiss();
    this.changesStore.close();
    this.reviews.clearActiveThread();
    await this.embeddedEditorStore.show();
  }

  async openFileInIde(location: SourceLocation) {
    if (!this.activeSession || !this.projectPath) return;
    this.commandPaneStore.dismiss();
    this.changesStore.close();
    await this.embeddedEditorStore.show(location);
  }

  /** Routes a VS Code selection to either contextual code chat or the project composer. */
  private async handleEmbeddedEditorSelection(
    event: Extract<DesktopClientEvent, { type: "embedded-editor-selection" }>,
  ) {
    if (
      event.workspacePath !== this.projectPath ||
      !this.activeSessionExists ||
      event.endLine < event.startLine
    )
      return;
    this.changesStore.close();
    this.reviews.clearActiveThread();
    if (!this.embeddedEditorStore.visible)
      await this.embeddedEditorStore.show({ path: event.path });
    if (this.signal.aborted || event.workspacePath !== this.projectPath) return;
    const location: SourceLocation = {
      path: event.path,
      documentVersion: event.documentVersion,
      range: {
        start: { line: event.startLine, column: event.startColumn },
        end: { line: event.endLine, column: event.endColumn },
      },
    };
    if (event.action === "add-to-project-chat") {
      this.reviews.cancelDraft();
      this.reviews.clearActiveThread();
      this.activeSession?.composerStore.addSourceAttachment({
        kind: "source",
        name: event.path.slice(-512),
        location,
        selectedText: event.selectedText,
        contextBefore: event.contextBefore,
        contextAfter: event.contextAfter,
      });
      return;
    }
    const anchor: ReviewAnchor = {
      path: event.path,
      view: "file",
      start: {
        diffLine: event.startLine,
        oldLine: event.startLine + 1,
        newLine: event.startLine + 1,
        column: event.startColumn,
      },
      end: {
        diffLine: event.endLine,
        oldLine: event.endLine + 1,
        newLine: event.endLine + 1,
        column: event.endColumn,
      },
      selectedText: event.selectedText,
      contextBefore: event.contextBefore,
      contextAfter: event.contextAfter,
      diff: "",
    };
    this.reviews.prepareDraft(anchor);
  }

  dismissSecondarySurfaces() {
    this.commandPaneStore.dismiss();
    this.closeEmbeddedEditor();
    this.changesStore.close();
  }

  sessionContext() {
    if (!this.projectPath || !this.session) return undefined;
    return { workspacePath: this.projectPath, sessionId: this.session.sessionId };
  }

  openingSession(sessionId: string) {
    return this.activeOpenTarget?.sessionId === sessionId;
  }

  isOpeningNewSession(operationId: string) {
    return this.activeOpenOperationId === operationId && this.activeOpenTarget?.newSession === true;
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
    newSession = false,
  ) {
    const restartDraft = this.draftAfterAgentRestart;
    this.projectPath = snapshot.workspacePath;
    this.selectedSessionId = snapshot.sessionId;
    const activeSession = this.sessionRegistry.ensure(snapshot.sessionId);
    if (newSession)
      this.sessionRegistry.rememberNewSession(snapshot.workspacePath, snapshot.sessionId);
    this.markSessionRead(snapshot.sessionId);
    this.props
      .persistence()
      .applySessionRestore(activeSession, previousSessionId, restartDraft, newSession);
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
    this.props.projects.recordOpened(snapshot.workspacePath);
    this.props.persistence().schedule();
    void this.reviews.loadThreads(snapshot.sessionId);
    if (focusComposer) activeSession.composerStore.requestFocus();
  }

  isActiveSession(sessionId: string) {
    return this.selectedSessionId === sessionId;
  }

  acceptSessionSnapshot(event: Extract<DesktopClientEvent, { type: "session-snapshot-received" }>) {
    if (event.operationId) {
      if (this.sessionForkStore.acceptSnapshotOperation(event.operationId)) return true;
      if (event.operationId !== this.activeOpenOperationId) {
        this.finishOperation(event.operationId);
        return false;
      }
      if (
        this.activeOpenTarget?.newSession &&
        this.activeOpenTarget.sessionId &&
        this.activeOpenTarget.sessionId !== event.snapshot.sessionId
      ) {
        this.sessionRegistry.discardNewSession(
          this.activeOpenTarget.path,
          this.activeOpenTarget.sessionId,
        );
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
      event.type === "embedded-editor-activity" ||
      event.type === "embedded-editor-context-cleared"
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
    if (event.type === "embedded-editor-toggle-chat") {
      if (event.workspacePath === this.projectPath) this.embeddedEditorStore.toggleChatSidebar();
      return;
    }
    if (event.type === "embedded-editor-location-opened") {
      if (event.workspacePath === this.projectPath) this.embeddedEditorStore.showAgentLocation();
      return;
    }
    if (event.type === "embedded-editor-selection") {
      void this.handleEmbeddedEditorSelection(event);
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
        this.sessionForkStore.reset();
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
        this.showTemporarySession(event.path, pending.sessionId ?? crypto.randomUUID());
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
    if (event.type === "changes-received") return;
    if (event.type === "changelog-received") {
      this.commandPaneStore.receive(event);
      return;
    }
    if (event.type === "ui-requested") return;
    if (event.type === "operation-completed") {
      if (this.commandPaneStore.receive(event)) return;
      this.sessionManagementStore.receive(event);
      if (this.activeOperations.includes(event.operationId)) {
        this.finishOperation(event.operationId);
      }
      return;
    }
    if (event.type === "operation-failed") {
      if (this.commandPaneStore.receive(event)) return;
      this.sessionManagementStore.receive(event);
      this.sessionForkStore.receive(event);
      if (!event.operationId || !this.activeOperations.includes(event.operationId)) return;
      this.finishOperation(event.operationId);
      if (event.operationId === this.activeOpenOperationId) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      this.error = event.message;
      this.errorDetails = event.details ?? event.message;
    }
  }
}
