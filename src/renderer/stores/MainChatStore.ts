import { Store, observable, untracked } from "r-state-tree";
import type {
  ApplicationState,
  SessionSnapshot,
  WindowViewState
} from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent, PiState } from "../desktop-client";
import type { BrowseStore } from "./BrowseStore";
import type { ChangesStore } from "./ChangesStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { SidebarStore } from "./SidebarStore";
import type { SettingsStore } from "./SettingsStore";
import type { ExtensionUiStore } from "./ExtensionUiStore";
import type { ArtifactInteractionStore } from "./ArtifactInteractionStore";
import type { MessageComposerStore } from "./MessageComposerStore";
import type { TranscriptViewStore } from "./TranscriptViewStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionCacheStore } from "./SessionCacheStore";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import { describeError } from "../error-details";

export interface MainChatStoreProps {
  client: Pick<DesktopClient,
    | "abort"
    | "archiveSession"
    | "chooseProject"
    | "createWindow"
    | "forkSession"
    | "getChangelog"
    | "getHomeDirectory"
    | "inspectWorkspace"
    | "listSessions"
    | "loadApplicationState"
    | "loadSession"
    | "loadWindowState"
    | "navigateSession"
    | "openWorkspace"
    | "registerProject"
    | "removeProject"
    | "renameProject"
    | "renameSession"
    | "respondToWorkspaceTrust"
    | "restartPi"
    | "saveWindowState"
  >;
  sessionCache: SessionCacheStore;
  operations: SessionOperationCoordinator;
  sidebar(): SidebarStore;
  browse(): BrowseStore;
  changes(): ChangesStore;
  reviews(): ReviewsStore;
  settings(): SettingsStore;
  extensionUi(): ExtensionUiStore;
  artifacts(): ArtifactInteractionStore;
  composer(): MessageComposerStore;
  transcriptView(): TranscriptViewStore;
  pluginCommands(): PluginCommandStore;
  catalog: SessionCatalogStore;
}

/** Owns the active conversation, composer, and session interaction workflow. */
export class MainChatStore extends Store<MainChatStoreProps> {
  readonly process = "renderer" as const;
  piState: PiState = "starting";
  hydrated = false;
  projectPath: string | undefined;
  selectedSessionId: string | undefined;
  pendingTrustPath: string | undefined;
  private pendingOpen: { inspectOperationId: string; path: string; newSession: boolean; sessionId?: string } | undefined;
  private activeOpenOperationId: string | undefined;
  private activeOpenTarget: { path: string; sessionId?: string; newSession: boolean } | undefined;
  private activeOpenExpectsEmpty = false;
  draft = "";
  commandPane: "changelog" | "tree" | "resources" | undefined;
  draftsBySession: Record<string, string> = observable({});
  changelogMarkdown = "";
  changelogLoading = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private pendingRenames: Record<string, { workspacePath: string; sessionId: string; previousTitle: string }> = observable({});
  private openRevision = 0;
  private reopenAfterAgentRestart = false;
  private draftAfterAgentRestart: string | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: MainChatStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => { void this.hydrate(); });
      return () => {
        if (this.persistTimer) clearTimeout(this.persistTimer);
      };
    });
  }

  private get sidebar() { return this.props.sidebar(); }
  private get browse() { return this.props.browse(); }
  private get changes() { return this.props.changes(); }
  private get reviews() { return this.props.reviews(); }
  private get settings() { return this.props.settings(); }
  private get extensionUi() { return this.props.extensionUi(); }
  private get artifactInteractions() { return this.props.artifacts(); }
  private get composer() { return this.props.composer(); }
  private get transcriptView() { return this.props.transcriptView(); }

  get isBusy() {
    return this.activeOperations.length > 0;
  }
  get activeOperations() { return this.props.operations.active("main-chat"); }

  get client() {
    return this.props.client;
  }

  get sessionCache() {
    return this.props.sessionCache;
  }

  get session() {
    return this.selectedSessionId && this.projectPath
      ? this.sessionCache.find(this.selectedSessionId, this.projectPath)
      : undefined;
  }

  get canonicalParts() {
    return this.session?.uiParts ?? [];
  }

  get visibleParts() {
    return this.session?.piSettings?.hideThinkingBlock
      ? this.composer.parts.filter((part) => part.kind !== "reasoning")
      : this.composer.parts;
  }

  get artifacts() {
    return this.session?.artifacts.map((artifact) => artifact.value) ?? [];
  }

  get sessionTitle() {
    const context = this.sessionContext();
    const title = context ? this.props.catalog.find(context.workspacePath, context.sessionId)?.title : undefined;
    return title ? this.sessionDisplayTitle(title) : "New chat";
  }

  sessionDisplayTitle(title: string) {
    return this.sidebar.sessionDisplayTitle(title);
  }

  get isStreaming() {
    return this.session?.streaming ?? false;
  }

  get canSubmit() {
    return Boolean(this.session && !this.activeOpenOperationId && (this.draft.trim() || this.composer.attachments.length > 0 || this.reviews.pendingThreads.length > 0) && (this.isLocalSlashCommand || this.piState === "ready"));
  }

  get isLocalSlashCommand() {
    const command = this.draft.trim().toLocaleLowerCase();
    return command === "/tree" || command === "/resources" || command === "/changelog" || this.props.pluginCommands().matches(this.draft);
  }

  get pluginCommands() { return this.props.pluginCommands().commands; }

  get projectName() {
    return this.projectPath ? this.sidebar.nameFromPath(this.projectPath) : "No workspace";
  }

  private markSessionRead(workspacePath: string, sessionId: string) { this.sidebar.markSessionRead(workspacePath, sessionId); }

  private async hydrate() {
    try {
      const [state, application, sessionIndex] = await Promise.all([this.client.loadWindowState(), this.client.loadApplicationState(), this.client.listSessions()]);
      if (this.signal.aborted) return;
      this.applyApplicationState(application);
      this.props.catalog.replace(sessionIndex.sessions);
      const reviewsBySession = new Map<string, typeof sessionIndex.reviewThreads>();
      for (const thread of sessionIndex.reviewThreads) {
        const key = this.reviewSessionKey(thread.workspacePath, thread.sessionId);
        const threads = reviewsBySession.get(key) ?? [];
        threads.push(thread);
        reviewsBySession.set(key, threads);
      }
      for (const session of sessionIndex.sessions) this.sessionCache.applyReviewThreads(session.workspacePath, session.id, reviewsBySession.get(this.reviewSessionKey(session.workspacePath, session.id)) ?? []);
      this.projectPath = state.projectPath;
      this.sidebar.recentProjectPaths.splice(0, this.sidebar.recentProjectPaths.length, ...state.recentProjectPaths);
      this.draft = state.draft;
      this.settings.theme = state.theme;
      this.transcriptView.setThinkingExpanded(state.thinkingExpanded);
      this.sidebar.search = state.sessionSearch;
      for (const sessionId of Object.keys(this.draftsBySession)) delete this.draftsBySession[sessionId];
      Object.assign(this.draftsBySession, state.draftsBySession);
      this.hydrated = true;
      if (state.projectPath) {
        const selectedSession = state.selectedSessionId
          ? sessionIndex.sessions.find((session) => session.workspacePath === state.projectPath && session.id === state.selectedSessionId)
          : undefined;
        await this.inspectPath(state.projectPath, Boolean(state.selectedSessionId && !selectedSession), selectedSession?.id);
      }
    } catch (error) {
      if (this.signal.aborted) return;
      this.hydrated = true;
      this.setError(error);
    }
  }

  private viewState(): WindowViewState {
    return {
      projectPath: this.projectPath,
      selectedSessionId: this.session?.sessionId,
      recentProjectPaths: this.sidebar.recentProjectPaths.slice(),
      draft: this.draft,
      theme: this.settings.theme,
      thinkingExpanded: this.transcriptView.thinkingExpanded,
      sessionSearch: this.sidebar.search,
      draftsBySession: { ...this.draftsBySession }
    };
  }

  private applyApplicationState(state: ApplicationState) {
    this.sidebar.applyApplicationState(state);
  }

  private schedulePersist() {
    if (!this.hydrated) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.client.saveWindowState(this.viewState()).catch((error) => this.setError(error));
    }, 180);
  }

  startOperation() {
    const operationId = this.props.operations.start("main-chat");
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
    try { this.applyApplicationState(await this.client.renameProject(path, name)); }
    catch (error) { this.setError(error); }
  }

  async removeProject(path: string) {
    try {
      this.applyApplicationState(await this.client.removeProject(path));
      if (this.projectPath === path) {
        this.projectPath = undefined;
        this.selectedSessionId = undefined;
      }
      this.schedulePersist();
    } catch (error) { this.setError(error); }
  }

  async createWindow() {
    try { await this.client.createWindow(); }
    catch (error) { this.setError(error); }
  }

  async startNewSession(path = this.projectPath) {
    if (!path) {
      await this.chooseProject();
      return;
    }
    if (path === this.projectPath) await this.openPath(path, true);
    else await this.inspectPath(path, true);
  }

  async openSession(workspacePath: string, sessionId: string) {
    this.markSessionRead(workspacePath, sessionId);
    if (workspacePath === this.projectPath && sessionId === this.session?.sessionId) return;
    const sameWorkspace = workspacePath === this.projectPath;
    const cached = this.showCachedSession(workspacePath, sessionId);
    if (!cached) void this.loadSessionPreview(workspacePath, sessionId);
    if (sameWorkspace) await this.openPath(workspacePath, false, sessionId);
    else await this.inspectPath(workspacePath, false, sessionId);
  }

  private async loadSessionPreview(workspacePath: string, sessionId: string) {
    try {
      const preview = await this.client.loadSession(workspacePath, sessionId);
      if (!preview || this.signal.aborted) return;
      const pendingMatches = this.pendingOpen?.path === workspacePath && this.pendingOpen.sessionId === sessionId;
      const activeMatches = this.activeOpenTarget?.path === workspacePath && this.activeOpenTarget.sessionId === sessionId;
      if (!pendingMatches && !activeMatches) return;
      this.sessionCache.hydratePreview(preview);
      this.showCachedSession(workspacePath, sessionId);
    } catch {
      // Runtime activation remains authoritative when the fast disk preview is unavailable.
    }
  }

  private showCachedSession(workspacePath: string, sessionId: string) {
    const session = this.sessionCache.find(sessionId, workspacePath);
    if (!session) return false;
    const previousSessionId = this.session?.sessionId;
    if (previousSessionId) this.draftsBySession[previousSessionId] = this.draft;
    this.projectPath = workspacePath;
    this.selectedSessionId = sessionId;
    this.markSessionRead(workspacePath, sessionId);
    this.draft = this.draftsBySession[sessionId] ?? "";
    this.extensionUi.clear();
    this.commandPane = undefined;
    this.changes.reset();
    this.browse.close();
    this.schedulePersist();
    this.composer.requestFocus();
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
      await this.client.respondToWorkspaceTrust({ operationId: pending.inspectOperationId, path: pending.path, approved: trusted });
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
    if (this.artifactInteractions.request) await this.artifactInteractions.respond(undefined, true);
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.activeOpenOperationId = operationId;
    this.activeOpenTarget = { path, sessionId, newSession };
    this.activeOpenExpectsEmpty = newSession;
    this.extensionUi.clear();
    this.artifactInteractions.request = undefined;
    this.commandPane = undefined;
    this.changes.reset();
    this.browse.close();
    try {
      await this.client.openWorkspace({ operationId, path, newSession, sessionId });
      void this.client.registerProject(path, this.sidebar.nameFromPath(path)).then((state) => this.applyApplicationState(state)).catch((error) => this.setError(error));
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

  setDraft(value: string) {
    this.draft = value;
    if (this.session) this.draftsBySession[this.session.sessionId] = value;
    this.schedulePersist();
  }

  persistViewState() { this.schedulePersist(); }


  async openCommandPane(pane: "changelog" | "tree" | "resources") {
    this.commandPane = pane;
    if (pane === "changelog") await this.refreshChangelog();
  }

  closeCommandPane() {
    this.commandPane = undefined;
    this.composer.requestFocus();
  }

  async openSessionChanges(threadId?: string) {
    this.commandPane = undefined;
    const thread = threadId ? this.reviews.threads.find((item) => item.id === threadId) : this.reviews.openThreads.find((item) => item.anchor.view !== "file");
    if (thread?.anchor.view === "file") {
      await this.openWorkspaceBrowser(thread.anchor.path);
      this.reviews.activeThreadId = thread.id;
      return;
    }
    this.browse.close();
    this.reviews.activeThreadId = thread?.id;
    await this.changes.open(thread?.anchor.path);
  }

  async openWorkspaceBrowser(path?: string) {
    this.commandPane = undefined;
    this.changes.close();
    this.reviews.activeThreadId = undefined;
    await this.browse.open(path);
  }


  sessionContext() {
    if (!this.projectPath || !this.session) return undefined;
    return { workspacePath: this.projectPath, sessionId: this.session.sessionId };
  }

  openingSession(workspacePath: string, sessionId: string) {
    return this.activeOpenTarget?.path === workspacePath && this.activeOpenTarget.sessionId === sessionId;
  }

  private reviewSessionKey(workspacePath: string, sessionId: string) { return `${workspacePath}\u0000${sessionId}`; }

  async refreshChangelog() {
    const context = this.sessionContext();
    if (!context || this.changelogLoading) return;
    const operationId = this.startOperation();
    this.changelogLoading = true;
    try { await this.client.getChangelog({ operationId, ...context }); }
    catch (error) { this.changelogLoading = false; this.finishOperation(operationId); this.setError(error); }
  }

  async renameCurrentSession(name: string) {
    const context = this.sessionContext(); if (!context || !name.trim()) return;
    await this.renameSession(context.workspacePath, context.sessionId, name);
  }

  async renameSession(workspacePath: string, sessionId: string, name: string) {
    if (!name.trim()) return;
    const operationId = this.startOperation();
    try {
      const title = name.trim();
      const previousTitle = this.props.catalog.rename(workspacePath, sessionId, title);
      if (previousTitle !== undefined) this.pendingRenames[operationId] = { workspacePath, sessionId, previousTitle };
      try {
        await this.client.renameSession({ operationId, workspacePath, sessionId, name: title });
      } catch (error) {
        this.rollbackRename(operationId);
        throw error;
      }
    }
    catch (error) { this.finishOperation(operationId); this.setError(error); }
  }

  async archiveSession(workspacePath: string, sessionId: string, archived: boolean) {
    try { this.applyApplicationState(await this.client.archiveSession(workspacePath, sessionId, archived)); }
    catch (error) { this.setError(error); }
  }

  async forkAt(entryId: string) {
    const context = this.sessionContext(); if (!context) return;
    this.closeCommandPane();
    const operationId = this.startOperation(); this.activeOpenOperationId = operationId;
    try { await this.client.forkSession({ operationId, ...context, entryId }); }
    catch (error) { this.finishOperation(operationId); this.setError(error); }
  }

  async navigateTo(entryId: string) {
    const context = this.sessionContext(); if (!context) return;
    const editorText = this.session?.tree.find((entry) => entry.id === entryId)?.editorText;
    this.closeCommandPane();
    const operationId = this.startOperation();
    try {
      await this.client.navigateSession({ operationId, ...context, entryId });
      if (editorText !== undefined) this.setDraft(editorText);
    }
    catch (error) { this.finishOperation(operationId); this.setError(error); }
  }

  async restartPi() {
    if (!this.projectPath) return;
    try { await this.client.restartPi(this.projectPath); }
    catch (error) { this.setError(error); }
  }

  async abort() {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.abort({ operationId, ...context });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  applySessionSnapshot(snapshot: SessionSnapshot, previousSessionId?: string, focusComposer = false) {
    const restartDraft = this.draftAfterAgentRestart;
    if (previousSessionId) this.draftsBySession[previousSessionId] = this.draft;
    this.projectPath = snapshot.workspacePath;
    this.selectedSessionId = snapshot.sessionId;
    this.markSessionRead(snapshot.workspacePath, snapshot.sessionId);
    this.draft = restartDraft ?? this.draftsBySession[snapshot.sessionId] ?? (previousSessionId ? "" : this.draft);
    this.draftAfterAgentRestart = undefined;
    this.draftsBySession[snapshot.sessionId] = this.draft;
    if (previousSessionId !== undefined) this.extensionUi.clear();
    this.extensionUi.applyState(snapshot.extensionUi);
    this.pendingOpen = undefined;
    const workspaceName = this.sidebar.projects.find((project) => project.path === snapshot.workspacePath)?.name ?? this.sidebar.nameFromPath(snapshot.workspacePath);
    this.props.catalog.applyWorkspace(snapshot.workspacePath, workspaceName, snapshot.sessions);
    if (!this.sidebar.recentProjectPaths.includes(snapshot.workspacePath)) this.sidebar.recentProjectPaths.push(snapshot.workspacePath);
    this.schedulePersist();
    void this.reviews.loadThreads(snapshot.workspacePath, snapshot.sessionId);
    if (focusComposer) this.composer.requestFocus();
  }

  isActiveSession(workspacePath: string, sessionId: string) {
    return this.projectPath === workspacePath && this.selectedSessionId === sessionId;
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
    } else if (!this.session || event.snapshot.sessionId !== this.session.sessionId || event.snapshot.workspacePath !== this.session.workspacePath) {
      return false;
    }
    if (event.operationId) this.finishOperation(event.operationId);
    return true;
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "pi-state-changed") {
      if (event.workspacePath && event.workspacePath !== this.projectPath && event.workspacePath !== this.pendingOpen?.path) return;
      this.piState = event.state;
      if (event.state === "failed" || event.state === "stopped") {
        this.reopenAfterAgentRestart = Boolean(this.projectPath && this.session);
        if (this.reopenAfterAgentRestart) this.draftAfterAgentRestart = this.draft;
        this.props.operations.reset();
        for (const operationId of Object.keys(this.pendingRenames)) this.rollbackRename(operationId);
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      if (event.state === "ready" && this.reopenAfterAgentRestart && this.projectPath && this.session) {
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
    if (event.type === "session-snapshot-received" || event.type === "part-updated" || event.type === "part-removed" || event.type === "streaming-changed") return;
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
      if (!this.isActiveSession(event.workspacePath, event.sessionId)) return;
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
    this.props.catalog.rename(pending.workspacePath, pending.sessionId, pending.previousTitle);
    delete this.pendingRenames[operationId];
  }
}
