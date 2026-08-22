import { Store, child, createStore, observable } from "r-state-tree";
import type {
  ApplicationState,
  GlobalSessionSummary,
  SessionSnapshot,
  WindowViewState,
} from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent, PiState } from "../desktop-client";
import { BrowseStore } from "./BrowseStore";
import { ChangesStore } from "./ChangesStore";
import { EmbeddedEditorStore } from "./EmbeddedEditorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { ExtensionUiStore } from "./ExtensionUiStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { WindowPersistenceCoordinatorStore } from "./WindowPersistenceCoordinatorStore";
import { describeError } from "../error-details";

export interface ProjectWorkbenchStoreProps {
  client: Pick<
    DesktopClient,
    | "abort"
    | "resolveSessions"
    | "resolveSession"
    | "chooseProject"
    | "forkSession"
    | "getChangelog"
    | "getHomeDirectory"
    | "inspectWorkspace"
    | "inspectChanges"
    | "listWorkspaceFiles"
    | "loadSession"
    | "navigateSession"
    | "openEmbeddedEditor"
    | "updateEmbeddedEditorBounds"
    | "revealInEmbeddedEditor"
    | "getEmbeddedEditorState"
    | "installEmbeddedEditor"
    | "setVscodeServerPath"
    | "openWorkspace"
    | "registerProject"
    | "readWorkspaceFile"
    | "removeProject"
    | "renameProject"
    | "renameSession"
    | "respondToWorkspaceTrust"
    | "restartPi"
  >;
  sessionRegistry: SessionRegistryStore;
  operations: SessionOperationCoordinatorStore;
  projects: ProjectCatalogStore;
  reviews(): ReviewsStore;
  extensionUi(): ExtensionUiStore;
  pluginCommands(): PluginCommandStore;
  persistence(): WindowPersistenceCoordinatorStore;
  catalog: SessionCatalogStore;
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
  commandPane: "changelog" | "tree" | "resources" | undefined;
  changelogMarkdown = "";
  changelogLoading = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private pendingRenames: Record<string, { sessionId: string; previousTitle: string }> = observable(
    {},
  );
  private openRevision = 0;
  private reopenAfterAgentRestart = false;
  private draftAfterAgentRestart: string | undefined;

  private get reviews() {
    return this.props.reviews();
  }
  private get extensionUi() {
    return this.props.extensionUi();
  }

  @child
  get browseStore(): BrowseStore {
    return createStore(BrowseStore, {
      client: this.client,
      projectPath: () => this.projectPath,
    });
  }

  @child
  get embeddedEditorStore(): EmbeddedEditorStore {
    return createStore(EmbeddedEditorStore, {
      client: this.client,
      projectPath: () => this.projectPath,
      schedulePersistence: () => this.props.persistence().schedule(),
    });
  }

  @child
  get changesStore(): ChangesStore {
    return createStore(ChangesStore, {
      client: this.client,
      projectPath: () => this.projectPath,
      sessionId: () => this.session?.sessionId,
      parts: () => this.activeSession?.canonicalParts ?? [],
      operations: this.props.operations,
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

  get sessionTitle() {
    const context = this.sessionContext();
    const title = context ? this.props.catalog.find(context.sessionId)?.title : undefined;
    return title ?? "New chat";
  }

  get isLocalSlashCommand() {
    const draft = this.activeSession?.chatStore.draft ?? "";
    const command = draft.trim().toLocaleLowerCase();
    return (
      command === "/tree" ||
      command === "/resources" ||
      command === "/changelog" ||
      this.props.pluginCommands().matches(draft)
    );
  }

  canSubmitSession(sessionId: string) {
    if (!this.isActiveSession(sessionId) || this.activeOpenOperationId) return false;
    const session = this.sessionRegistry.findSession(sessionId);
    if (!session) return false;
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

  async chooseProject() {
    const path = await this.client.chooseProject();
    if (path && !this.signal.aborted) await this.inspectPath(path);
  }

  async startOneOffChat() {
    try {
      const path = await this.client.getHomeDirectory();
      if (!this.signal.aborted) await this.inspectPath(path, true);
    } catch (error) {
      this.setError(error);
    }
  }

  async switchProject(path: string) {
    if (path === this.projectPath) return;
    await this.inspectPath(path);
  }

  async renameProject(path: string, name: string) {
    try {
      this.applyApplicationState(await this.client.renameProject(path, name));
    } catch (error) {
      this.setError(error);
    }
  }

  async removeProject(path: string) {
    try {
      this.applyApplicationState(await this.client.removeProject(path));
      if (this.projectPath === path) {
        this.projectPath = undefined;
        this.selectedSessionId = undefined;
      }
      this.props.persistence().schedule();
    } catch (error) {
      this.setError(error);
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
      await this.openSession(pending.sessionId);
      return;
    }
    if (path === this.projectPath) await this.openPath(path, true);
    else await this.inspectPath(path, true);
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
    this.projectPath = session.workspacePath;
    this.selectedSessionId = sessionId;
    this.markSessionRead(sessionId);
    this.extensionUi.clear();
    this.commandPane = undefined;
    this.changesStore.reset();
    this.browseStore.close();
    this.embeddedEditorStore.close();
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
      this.pendingOpen = undefined;
      this.setError(error);
      return;
    }
    if (!trusted) {
      this.pendingOpen = undefined;
      return;
    }
    await this.openPath(pending.path, pending.newSession, pending.sessionId);
  }

  private async openPath(path: string, newSession = false, sessionId?: string) {
    if (this.activeSession?.artifactInteractionStore.request)
      await this.activeSession.artifactInteractionStore.respond(undefined, true);
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.activeOpenOperationId = operationId;
    this.activeOpenTarget = { path, sessionId, newSession };
    this.activeOpenExpectsEmpty = newSession;
    this.extensionUi.clear();
    if (this.activeSession) this.activeSession.artifactInteractionStore.request = undefined;
    this.commandPane = undefined;
    this.changesStore.reset();
    this.browseStore.close();
    this.embeddedEditorStore.close();
    try {
      await this.client.openWorkspace({ operationId, path, newSession, sessionId });
      void this.client
        .registerProject(path, this.props.projects.nameFromPath(path))
        .then((state) => this.applyApplicationState(state))
        .catch((error) => this.setError(error));
    } catch (error) {
      if (revision === this.openRevision) this.setError(error);
      if (this.activeOpenOperationId === operationId) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      this.finishOperation(operationId);
    }
  }

  async openCommandPane(pane: "changelog" | "tree" | "resources") {
    this.commandPane = pane;
    if (pane === "changelog") await this.refreshChangelog();
  }

  closeCommandPane() {
    this.commandPane = undefined;
    this.activeSession?.composerStore.requestFocus();
  }

  async openSessionChanges(threadId?: string) {
    this.commandPane = undefined;
    const thread = threadId
      ? this.reviews.threads.find((item) => item.id === threadId)
      : this.reviews.openThreads.find((item) => item.anchor.view !== "file");
    if (thread?.anchor.view === "file") {
      await this.openWorkspaceBrowser(thread.anchor.path);
      this.reviews.activeThreadId = thread.id;
      return;
    }
    this.browseStore.close();
    this.embeddedEditorStore.close();
    this.reviews.activeThreadId = thread?.id;
    await this.changesStore.open(thread?.anchor.path);
  }

  async openWorkspaceBrowser(path?: string) {
    this.commandPane = undefined;
    this.changesStore.close();
    this.reviews.activeThreadId = undefined;
    await this.browseStore.open(path);
  }

  dismissSecondarySurfaces() {
    this.commandPane = undefined;
    this.browseStore.close();
    this.embeddedEditorStore.close();
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

  async refreshChangelog() {
    const context = this.sessionContext();
    if (!context || this.changelogLoading) return;
    const operationId = this.startOperation();
    this.changelogLoading = true;
    try {
      await this.client.getChangelog({ operationId, sessionId: context.sessionId });
    } catch (error) {
      this.changelogLoading = false;
      this.finishOperation(operationId);
      this.setError(error);
    }
  }

  async renameCurrentSession(name: string) {
    const context = this.sessionContext();
    if (!context || !name.trim()) return;
    await this.renameSession(context.sessionId, name);
  }

  async renameSession(sessionId: string, name: string) {
    if (!name.trim()) return;
    const operationId = this.startOperation();
    try {
      const title = name.trim();
      const previousTitle = this.props.catalog.rename(sessionId, title);
      if (previousTitle !== undefined)
        this.pendingRenames[operationId] = { sessionId, previousTitle };
      try {
        await this.client.renameSession({ operationId, sessionId, name: title });
      } catch (error) {
        this.rollbackRename(operationId);
        throw error;
      }
    } catch (error) {
      this.finishOperation(operationId);
      this.setError(error);
    }
  }

  async resolveSession(sessionId: string, resolved: boolean) {
    if (!this.props.catalog.find(sessionId)) return;
    try {
      this.applyApplicationState(await this.client.resolveSession(sessionId, resolved));
    } catch (error) {
      this.setError(error);
    }
  }

  async resolveSessions(sessionIds: readonly string[], resolved: boolean) {
    const sessionCount = sessionIds.length;
    try {
      this.applyApplicationState(await this.client.resolveSessions(sessionIds, resolved));
      return sessionCount;
    } catch (error) {
      this.setError(error);
      throw error;
    }
  }

  async resolveSessionsById(sessionIds: readonly string[], resolved: boolean) {
    for (const sessionId of sessionIds) {
      if (!this.props.catalog.find(sessionId))
        throw new Error(`Cake could not find session ${sessionId}`);
    }
    return this.resolveSessions(sessionIds, resolved);
  }

  async forkAt(entryId: string) {
    const context = this.sessionContext();
    if (!context) return;
    this.closeCommandPane();
    const operationId = this.startOperation();
    this.activeOpenOperationId = operationId;
    try {
      await this.client.forkSession({ operationId, sessionId: context.sessionId, entryId });
    } catch (error) {
      this.finishOperation(operationId);
      this.setError(error);
    }
  }

  async navigateTo(entryId: string) {
    const context = this.sessionContext();
    if (!context) return;
    const editorText = this.session?.tree.find((entry) => entry.id === entryId)?.editorText;
    this.closeCommandPane();
    const operationId = this.startOperation();
    try {
      await this.client.navigateSession({ operationId, sessionId: context.sessionId, entryId });
      if (editorText !== undefined) this.activeSession?.chatStore.setDraft(editorText);
    } catch (error) {
      this.finishOperation(operationId);
      this.setError(error);
    }
  }

  async restartPi() {
    if (!this.projectPath) return;
    try {
      await this.client.restartPi(this.projectPath);
    } catch (error) {
      this.setError(error);
    }
  }

  async abort() {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext();
      if (!context) throw new Error("No active session");
      await this.client.abort({ operationId, sessionId: context.sessionId });
    } catch (error) {
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
    this.props.catalog.applyWorkspace(snapshot.workspacePath, workspaceName, snapshot.sessions);
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
      if (event.operationId !== this.activeOpenOperationId) {
        this.finishOperation(event.operationId);
        return false;
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
      event.type === "embedded-editor-activity"
    ) {
      this.embeddedEditorStore.receive(event);
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
        this.reopenAfterAgentRestart = Boolean(this.projectPath && this.session);
        if (this.reopenAfterAgentRestart)
          this.draftAfterAgentRestart = this.activeSession?.chatStore.draft;
        this.props.operations.reset();
        for (const operationId of Object.keys(this.pendingRenames))
          this.rollbackRename(operationId);
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
      else {
        void this.openPath(event.path, pending.newSession, pending.sessionId);
      }
      return;
    }
    if (
      event.type === "session-snapshot-received" ||
      event.type === "part-updated" ||
      event.type === "part-removed" ||
      event.type === "streaming-changed"
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
      this.finishOperation(event.operationId);
      this.changelogLoading = false;
      if (!this.isActiveSession(event.sessionId)) return;
      this.changelogMarkdown = event.markdown;
      return;
    }
    if (event.type === "ui-requested") return;
    if (event.type === "operation-completed") {
      if (this.activeOperations.includes(event.operationId)) {
        delete this.pendingRenames[event.operationId];
        this.finishOperation(event.operationId);
      }
      return;
    }
    if (event.type === "operation-failed") {
      if (!event.operationId || !this.activeOperations.includes(event.operationId)) return;
      this.rollbackRename(event.operationId);
      this.finishOperation(event.operationId);
      if (event.operationId === this.activeOpenOperationId) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      this.setError(event.message);
    }
  }

  private rollbackRename(operationId: string) {
    const pending = this.pendingRenames[operationId];
    if (!pending) return;
    this.props.catalog.rename(pending.sessionId, pending.previousTitle);
    delete this.pendingRenames[operationId];
  }
}
