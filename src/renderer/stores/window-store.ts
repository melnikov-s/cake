import { Store, observable, untracked } from "r-state-tree";
import type {
  Attachment,
  ApplicationState,
  ChangedFile,
  ExtensionUiEvent,
  ExtensionUiState,
  FileSuggestion,
  GlobalSessionSummary,
  ModelOption,
  PiSettingUpdate,
  ProjectRecord,
  ResourceDiagnostic,
  SessionChange,
  SessionSnapshot,
  SessionTreeNode,
  ThinkingLevel,
  UiPart,
  WindowViewState
} from "../../ipc/session-contract";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { DesktopClientEvent, PiState } from "../desktop-client";
import { diffStats } from "../components/ai-elements/diff-view";
import { DesktopClientContext, SessionCacheContext } from "./context";
import type { ReviewAnchor } from "../../ipc/review-contract";

export interface UiRequestState {
  operationId: string;
  uiRequestId: string;
  kind: "confirm" | "text" | "secret" | "select" | "manual_code" | "editor";
  title: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  options?: Array<{ id: string; label: string }>;
}

export interface ExtensionNotification {
  id: string;
  message: string;
  tone: "info" | "warning" | "error";
}

export interface ArtifactRequestState {
  operationId: string;
  artifactRequestId: string;
  record: ArtifactRecord;
}

interface PendingUserMessage {
  operationId: string;
  workspacePath: string;
  sessionId: string;
  canonicalPartCount: number;
  expectedOccurrence: number;
  part: Extract<UiPart, { kind: "text" }>;
}

export interface ReviewRunState {
  operationId: string;
  workspacePath: string;
  sessionId: string;
  threadIds: string[];
  commentCount: number;
  status: "running" | "complete" | "error";
}

export class WindowStore extends Store<Record<string, never>> {
  readonly process = "renderer" as const;
  piState: PiState = "starting";
  hydrated = false;
  projectPath: string | undefined;
  selectedSessionId: string | undefined;
  recentProjectPaths: string[] = [];
  projects: ProjectRecord[] = [];
  globalSessions: GlobalSessionSummary[] = observable([]);
  sessionActivityByKey: Record<string, "running" | "unread"> = observable({});
  pendingTrustPath: string | undefined;
  private pendingOpen: { inspectOperationId: string; path: string; newSession: boolean; sessionId?: string; sessionFile?: string } | undefined;
  private activeOpenOperationId: string | undefined;
  private activeOpenTarget: { path: string; sessionId?: string; newSession: boolean } | undefined;
  private activeOpenExpectsEmpty = false;
  draft = "";
  theme: "system" | "light" | "dark" = "system";
  attachments: Attachment[] = [];
  thinkingExpanded = false;
  sessionSearch = "";
  commandPane: "changelog" | "tree" | "resources" | undefined;
  changeExplorerPath: string | null | undefined;
  pendingUserMessages: PendingUserMessage[] = observable([]);
  draftsBySession: Record<string, string> = observable({});
  sessionLimitsByProject: Record<string, number> = observable({});
  changedFiles: ChangedFile[] = [];
  changesLoading = false;
  changelogMarkdown = "";
  changelogLoading = false;
  error: string | undefined;
  uiRequest: UiRequestState | undefined;
  artifactRequest: ArtifactRequestState | undefined;
  extensionTitle: string | undefined;
  extensionStatuses: ExtensionUiState["statuses"] = observable([]);
  extensionWidgets: ExtensionUiState["widgets"] = observable([]);
  extensionNotifications: ExtensionNotification[] = observable([]);
  compatibilityDiagnostics: ResourceDiagnostic[] = observable([]);
  activeOperations: string[] = [];
  providerOperations: Record<string, { provider: string; kind: "login" | "logout" }> = observable({});
  reviewStreamingIds: string[] = observable([]);
  reviewSubmissionsByOperation: Record<string, string[]> = observable({});
  reviewRuns: ReviewRunState[] = observable([]);
  activeReviewThreadId: string | undefined;
  private openRevision = 0;
  private reopenAfterAgentRestart = false;
  private draftAfterAgentRestart: string | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: WindowStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => { void this.hydrate(); });
      return () => {
        if (this.persistTimer) clearTimeout(this.persistTimer);
      };
    });
  }

  get isBusy() {
    return this.activeOperations.length > 0;
  }

  get client() {
    const client = DesktopClientContext.consume(this);
    if (!client) throw new Error("DesktopClientContext is not provided");
    return client;
  }

  get sessionCache() {
    const sessions = SessionCacheContext.consume(this);
    if (!sessions) throw new Error("SessionCacheContext is not provided");
    return sessions;
  }

  async readWorkspaceFile(path: string) {
    if (!this.projectPath) throw new Error("No project is open");
    return this.client.readWorkspaceFile(this.projectPath, path);
  }

  get session() {
    return this.selectedSessionId && this.projectPath
      ? this.sessionCache.find(this.selectedSessionId, this.projectPath)
      : undefined;
  }

  get canonicalParts() {
    return this.session?.uiParts ?? [];
  }

  get parts() {
    if (!this.projectPath || !this.selectedSessionId) return this.canonicalParts;
    const pendingParts = this.pendingUserMessages
      .filter((pending) => pending.workspacePath === this.projectPath && pending.sessionId === this.selectedSessionId)
      .filter((pending) => this.userMessageOccurrenceCount(pending.workspacePath, pending.sessionId, pending.part.text) < pending.expectedOccurrence);
    if (pendingParts.length === 0) return this.canonicalParts;
    const parts = [...this.canonicalParts];
    pendingParts.forEach((pending, offset) => {
      parts.splice(Math.min(pending.canonicalPartCount + offset, parts.length), 0, pending.part);
    });
    return parts;
  }

  get visibleParts() {
    return this.session?.piSettings?.hideThinkingBlock
      ? this.parts.filter((part) => part.kind !== "reasoning")
      : this.parts;
  }

  get artifacts() {
    return this.session?.artifacts.map((artifact) => artifact.value) ?? [];
  }

  get sessionChanges() {
    const changesByCall = new Map((this.session?.sessionChanges ?? []).map((change) => [change.toolCallId, change]));
    for (const part of this.canonicalParts) {
      if (part.kind !== "tool" || part.name !== "edit" || part.state !== "success" || !part.filePath || !part.diff) continue;
      const toolCallId = part.id.startsWith("tool-") ? part.id.slice(5) : part.id;
      if (changesByCall.has(toolCallId)) continue;
      const stats = diffStats(part.diff);
      changesByCall.set(toolCallId, { id: part.id, toolCallId, toolName: part.name, path: part.filePath, ...stats, diff: part.diff, timestamp: new Date(0).toISOString() });
    }
    const changesByFile = new Map<string, SessionChange>();
    for (const change of changesByCall.values()) {
      const existing = changesByFile.get(change.path);
      if (!existing) {
        changesByFile.set(change.path, { ...change, id: `file:${change.path}` });
        continue;
      }
      changesByFile.set(change.path, {
        ...existing,
        additions: existing.additions + change.additions,
        deletions: existing.deletions + change.deletions,
        diff: `${existing.diff}\n${change.diff}`,
        timestamp: change.timestamp
      });
    }
    return [...changesByFile.values()];
  }

  get reviewThreads() { return this.session?.reviewThreads ?? []; }
  reviewThreadsForSession(workspacePath: string, sessionId: string) { return this.sessionCache.find(sessionId, workspacePath)?.reviewThreads ?? []; }
  private submittedReviewThreadIds() { return new Set(Object.values(this.reviewSubmissionsByOperation).flat()); }
  pendingReviewThreadsForSession(workspacePath: string, sessionId: string) {
    const submitting = this.submittedReviewThreadIds();
    return this.reviewThreadsForSession(workspacePath, sessionId).filter((thread) => thread.pending && !submitting.has(thread.id));
  }
  chatReviewThreadsForSession(workspacePath: string, sessionId: string) {
    const submitting = this.submittedReviewThreadIds();
    return this.reviewThreadsForSession(workspacePath, sessionId).filter((thread) => thread.actionableCommentCount > 0 && !submitting.has(thread.id));
  }
  chatReviewCommentCountForSession(workspacePath: string, sessionId: string) {
    return this.chatReviewThreadsForSession(workspacePath, sessionId).reduce((count, thread) => count + thread.actionableCommentCount, 0);
  }
  get openReviewThreads() { return this.reviewThreads.filter((thread) => thread.status === "open"); }
  get pendingReviewThreads() {
    const context = this.sessionContext();
    return context ? this.pendingReviewThreadsForSession(context.workspacePath, context.sessionId) : [];
  }
  get pendingReviewCommentCount() {
    return this.pendingReviewThreads.reduce((count, thread) => count + thread.messages.filter((message) => message.role === "user" && !message.delivered).length, 0);
  }
  get chatReviewThreads() {
    const context = this.sessionContext();
    return context ? this.chatReviewThreadsForSession(context.workspacePath, context.sessionId) : [];
  }
  get chatReviewCommentCount() {
    const context = this.sessionContext();
    return context ? this.chatReviewCommentCountForSession(context.workspacePath, context.sessionId) : 0;
  }
  reviewThreadStreaming(threadId: string) { return this.reviewStreamingIds.includes(threadId); }
  get sessionReviewRuns() {
    if (!this.projectPath || !this.session) return [];
    return this.reviewRuns.filter((run) => run.workspacePath === this.projectPath && run.sessionId === this.session!.sessionId);
  }
  get activeReviewThread() {
    return this.reviewThreads.find((thread) => thread.id === this.activeReviewThreadId) ?? this.openReviewThreads[0];
  }

  get selectedSessionChange() {
    return typeof this.changeExplorerPath === "string"
      ? this.sessionChanges.find((change) => change.path === this.changeExplorerPath) ?? this.sessionChanges[0]
      : this.sessionChanges[0];
  }

  get sessionTitle() {
    return this.session?.sessions.find((item) => item.id === this.session?.sessionId)?.title || "New chat";
  }

  get isStreaming() {
    return this.session?.streaming ?? false;
  }

  get canSubmit() {
    return Boolean(this.session && !this.activeOpenOperationId && (this.draft.trim() || this.pendingReviewThreads.length > 0) && (this.isLocalSlashCommand || this.piState === "ready"));
  }

  get isLocalSlashCommand() {
    const command = this.draft.trim().toLocaleLowerCase();
    return command === "/tree" || command === "/resources" || command === "/changelog";
  }

  get projectName() {
    return this.projectPath ? this.nameFromPath(this.projectPath) : "No workspace";
  }

  get currentSessions() {
    return this.projectPath ? this.projectSessions(this.projectPath) : [];
  }

  projectSessions(workspacePath: string) {
    return this.globalSessions
      .filter((item) => item.workspacePath === workspacePath);
  }

  sessionActivity(workspacePath: string, sessionId: string) {
    return this.sessionActivityByKey[this.sessionActivityKey(workspacePath, sessionId)];
  }

  updateSessionActivity(workspacePath: string, sessionId: string, streaming: boolean, wasStreaming = false) {
    const key = this.sessionActivityKey(workspacePath, sessionId);
    if (streaming) {
      this.sessionActivityByKey[key] = "running";
      return;
    }
    if (this.sessionActivityByKey[key] !== "running" && !wasStreaming) return;
    if (this.isActiveSession(workspacePath, sessionId) || (this.activeOpenTarget?.path === workspacePath && this.activeOpenTarget.sessionId === sessionId)) {
      delete this.sessionActivityByKey[key];
    } else {
      this.sessionActivityByKey[key] = "unread";
    }
  }

  private sessionActivityKey(workspacePath: string, sessionId: string) {
    return `${workspacePath}\u0000${sessionId}`;
  }

  private markSessionRead(workspacePath: string, sessionId: string) {
    const key = this.sessionActivityKey(workspacePath, sessionId);
    if (this.sessionActivityByKey[key] === "unread") delete this.sessionActivityByKey[key];
  }

  sessionLimit(workspacePath: string) {
    return this.sessionLimitsByProject[workspacePath] ?? 10;
  }

  showMoreSessions(workspacePath: string) {
    this.sessionLimitsByProject[workspacePath] = this.sessionLimit(workspacePath) + 10;
  }

  get searchedSessions() {
    const query = this.sessionSearch.trim().toLocaleLowerCase();
    if (!query) return [];
    return this.globalSessions
      .filter((item) => `${item.title}\n${item.workspaceName}\n${item.workspacePath}`.toLocaleLowerCase().includes(query));
  }

  nameFromPath(path: string) {
    const normalized = path.replace(/\/+$/, "");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
  }

  get modelsByProvider() {
    const groups = new Map<string, { name: string; models: ModelOption[] }>();
    for (const model of this.session?.models ?? []) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }

  get connectedModelsByProvider() {
    return this.modelsByProvider
      .map((group) => ({ ...group, models: group.models.filter((model) => model.authenticated) }))
      .filter((group) => group.models.length > 0);
  }

  private async hydrate() {
    try {
      const [state, application, sessionIndex] = await Promise.all([this.client.loadWindowState(), this.client.loadApplicationState(), this.client.listSessions()]);
      if (this.signal.aborted) return;
      this.applyApplicationState(application);
      this.globalSessions.splice(0, this.globalSessions.length, ...sessionIndex.sessions);
      const reviewsBySession = new Map<string, typeof sessionIndex.reviewThreads>();
      for (const thread of sessionIndex.reviewThreads) {
        const key = this.reviewSessionKey(thread.workspacePath, thread.sessionId);
        const threads = reviewsBySession.get(key) ?? [];
        threads.push(thread);
        reviewsBySession.set(key, threads);
      }
      for (const session of sessionIndex.sessions) this.sessionCache.applyReviewThreads(session.workspacePath, session.id, reviewsBySession.get(this.reviewSessionKey(session.workspacePath, session.id)) ?? []);
      this.projectPath = state.projectPath;
      this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...state.recentProjectPaths);
      this.draft = state.draft;
      this.theme = state.theme;
      this.thinkingExpanded = state.thinkingExpanded;
      this.sessionSearch = state.sessionSearch;
      for (const sessionId of Object.keys(this.draftsBySession)) delete this.draftsBySession[sessionId];
      Object.assign(this.draftsBySession, state.draftsBySession);
      this.hydrated = true;
      if (state.projectPath) await this.inspectPath(state.projectPath, false, state.selectedSessionId, state.selectedSessionFile);
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
      selectedSessionFile: this.session?.sessionFile,
      recentProjectPaths: this.recentProjectPaths.slice(),
      draft: this.draft,
      theme: this.theme,
      thinkingExpanded: this.thinkingExpanded,
      sessionSearch: this.sessionSearch,
      draftsBySession: { ...this.draftsBySession }
    };
  }

  private applyApplicationState(state: ApplicationState) {
    this.projects.splice(0, this.projects.length, ...state.projects);
    const names = new Map(state.projects.map((project) => [project.path, project.name]));
    const renamedSessions = this.globalSessions.map((session) => ({ ...session, workspaceName: names.get(session.workspacePath) ?? session.workspaceName }));
    this.globalSessions.splice(0, this.globalSessions.length, ...renamedSessions);
    const registeredPaths = new Set(state.projects.map((project) => project.path));
    const paths = this.recentProjectPaths.filter((path) => registeredPaths.has(path));
    for (const project of state.projects) if (!paths.includes(project.path)) paths.push(project.path);
    this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...paths);
  }

  private schedulePersist() {
    if (!this.hydrated) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.client.saveWindowState(this.viewState()).catch((error) => this.setError(error));
    }, 180);
  }

  private startOperation() {
    const operationId = crypto.randomUUID();
    this.activeOperations.push(operationId);
    this.error = undefined;
    return operationId;
  }

  private finishOperation(operationId: string) {
    const index = this.activeOperations.indexOf(operationId);
    if (index >= 0) this.activeOperations.splice(index, 1);
  }

  private setError(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
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

  async startNewSession() {
    if (!this.projectPath) {
      await this.chooseProject();
      return;
    }
    await this.openPath(this.projectPath, true);
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
    this.clearExtensionUi();
    this.commandPane = undefined;
    this.changeExplorerPath = undefined;
    this.schedulePersist();
    return true;
  }

  private async inspectPath(path: string, newSession = false, sessionId?: string, sessionFile?: string) {
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.clearExtensionUi();
    this.pendingTrustPath = undefined;
    this.pendingOpen = { inspectOperationId: operationId, path, newSession, sessionId, sessionFile };
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
    await this.openPath(pending.path, pending.newSession, pending.sessionId, pending.sessionFile);
  }

  private async openPath(path: string, newSession = false, sessionId?: string, sessionFile?: string) {
    if (this.artifactRequest) await this.respondToArtifact(undefined, true);
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.activeOpenOperationId = operationId;
    this.activeOpenTarget = { path, sessionId, newSession };
    this.activeOpenExpectsEmpty = newSession;
    this.uiRequest = undefined;
    this.artifactRequest = undefined;
    this.clearExtensionUi();
    this.commandPane = undefined;
    this.changeExplorerPath = undefined;
    try {
      await this.client.openWorkspace({ operationId, path, newSession, sessionId, sessionFile });
      void this.client.registerProject(path, this.nameFromPath(path)).then((state) => this.applyApplicationState(state)).catch((error) => this.setError(error));
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

  setTheme(theme: "system" | "light" | "dark") {
    this.theme = theme;
    this.schedulePersist();
  }

  toggleThinking() {
    this.thinkingExpanded = !this.thinkingExpanded;
    this.schedulePersist();
  }

  setSessionSearch(value: string) { this.sessionSearch = value; this.schedulePersist(); }

  async openCommandPane(pane: "changelog" | "tree" | "resources") {
    this.commandPane = pane;
    if (pane === "changelog") await this.refreshChangelog();
  }

  closeCommandPane() { this.commandPane = undefined; }

  async openSessionChanges(threadId?: string) {
    this.commandPane = undefined;
    const thread = threadId ? this.reviewThreads.find((item) => item.id === threadId) : this.openReviewThreads[0];
    this.activeReviewThreadId = thread?.id;
    this.changeExplorerPath = thread?.anchor.path ?? this.sessionChanges[0]?.path ?? null;
    await this.refreshSession();
  }

  async createReviewThread(anchor: ReviewAnchor, body: string) {
    const context = this.sessionContext();
    if (!context || !body.trim()) return false;
    try {
      const thread = await this.client.createReviewThread({ ...context, anchor, body: body.trim() });
      if (this.signal.aborted) return false;
      this.sessionCache.upsertReviewThread(thread);
      return true;
    } catch (error) { this.setError(error); return false; }
  }

  async replyReviewThread(threadId: string, body: string) {
    const context = this.sessionContext();
    if (!context || !body.trim()) return false;
    try {
      const thread = await this.client.replyReviewThread({ ...context, threadId, body: body.trim() });
      if (this.signal.aborted) return false;
      this.sessionCache.upsertReviewThread(thread);
      return true;
    } catch (error) { this.setError(error); return false; }
  }

  async resolveReviewThread(threadId: string, resolved = true) {
    const context = this.sessionContext();
    if (!context) return false;
    try {
      const thread = await this.client.resolveReviewThread({ ...context, threadId, resolved });
      if (this.signal.aborted) return false;
      this.sessionCache.upsertReviewThread(thread);
      return true;
    } catch (error) { this.setError(error); return false; }
  }

  private async loadReviewThreads(workspacePath: string, sessionId: string) {
    try {
      const threads = await this.client.listReviewThreads(workspacePath, sessionId);
      if (this.signal.aborted) return;
      this.sessionCache.applyReviewThreads(workspacePath, sessionId, threads);
    } catch (error) { if (!this.signal.aborted) this.setError(error); }
  }

  selectChangeExplorerFile(path: string) {
    if (this.sessionChanges.some((change) => change.path === path)) this.changeExplorerPath = path;
  }

  focusReviewThread(threadId: string) {
    const thread = this.reviewThreads.find((item) => item.id === threadId);
    if (!thread) return;
    this.activeReviewThreadId = thread.id;
    this.changeExplorerPath = thread.anchor.path;
  }

  closeChangeExplorer() { this.changeExplorerPath = undefined; this.activeReviewThreadId = undefined; }

  private sessionContext() {
    if (!this.projectPath || !this.session) return undefined;
    return { workspacePath: this.projectPath, sessionId: this.session.sessionId };
  }

  private reviewSessionKey(workspacePath: string, sessionId: string) { return `${workspacePath}\u0000${sessionId}`; }

  async refreshChanges() {
    if (!this.projectPath || this.changesLoading) return;
    const operationId = this.startOperation(); this.changesLoading = true;
    try { await this.client.inspectChanges({ operationId, workspacePath: this.projectPath }); }
    catch (error) { this.changesLoading = false; this.finishOperation(operationId); this.setError(error); }
  }

  async refreshSession() {
    const context = this.sessionContext();
    if (!context) return;
    const operationId = this.startOperation();
    try { await this.client.refreshSession({ operationId, ...context }); }
    catch (error) { this.finishOperation(operationId); this.setError(error); }
  }

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
      await this.client.renameSession({ operationId, workspacePath, sessionId, name: name.trim() });
      const session = this.globalSessions.find((item) => item.workspacePath === workspacePath && item.id === sessionId);
      if (session) session.title = name.trim();
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
    const findNode = (nodes: SessionTreeNode[]): SessionTreeNode | undefined => {
      for (const node of nodes) {
        if (node.id === entryId) return node;
        const child = findNode(node.children);
        if (child) return child;
      }
      return undefined;
    };
    const editorText = findNode(this.session?.tree ?? [])?.editorText;
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

  async addAttachments() {
    try {
      const selected = await this.client.chooseAttachments();
      if (this.signal.aborted) return;
      const fileMentions = selected
        .filter((item): item is Extract<Attachment, { kind: "file" }> => item.kind === "file")
        .map((item) => /[\s"]/.test(item.path) ? `@"${item.path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : `@${item.path}`);
      if (fileMentions.length > 0) {
        const separator = this.draft.length > 0 && !/\s$/.test(this.draft) ? " " : "";
        this.setDraft(`${this.draft}${separator}${fileMentions.join(" ")}`);
      }
      const images = selected.filter((item): item is Extract<Attachment, { kind: "image" }> => item.kind === "image");
      this.attachments.push(...images.filter((item) => !this.attachments.some((current) => current.kind === "image" && current.name === item.name)));
    } catch (error) {
      this.setError(error);
    }
  }

  async suggestFiles(prefix: string): Promise<FileSuggestion[]> {
    if (!this.projectPath) return [];
    return this.client.suggestFiles(this.projectPath, prefix);
  }

  removeAttachment(index: number) {
    this.attachments.splice(index, 1);
  }

  async submit(deliveryOverride?: "steer") {
    if (!this.canSubmit) return;
    const text = this.draft.trim();
    const command = text.toLocaleLowerCase();
    if (command === "/tree" || command === "/resources" || command === "/changelog") {
      this.setDraft("");
      await this.openCommandPane(command === "/tree" ? "tree" : command === "/changelog" ? "changelog" : "resources");
      return;
    }
    const delivery = deliveryOverride ?? (this.isStreaming ? "follow-up" : "prompt");
    const attachments = this.attachments.slice();
    const reviews = this.pendingReviewThreads.map((thread) => thread.id);
    const context = this.sessionContext();
    if (!context) return;
    this.setDraft("");
    const submissions: Promise<void>[] = [];
    if (reviews.length > 0) {
      submissions.push(this.submitReviewComments(reviews, text || undefined));
    }
    if (text) {
      const messageOperationId = this.startOperation();
      this.attachments.splice(0);
      this.addPendingUserMessage(messageOperationId, context.workspacePath, context.sessionId, text);
      submissions.push(this.client.submit({ operationId: messageOperationId, ...context, text, delivery, attachments }).catch((error) => {
        this.removePendingUserMessage(messageOperationId);
        this.setError(error);
        if (!this.draft.trim()) this.setDraft(text);
        this.attachments.push(...attachments);
        this.finishOperation(messageOperationId);
      }));
    }
    await Promise.all(submissions);
  }

  async sendPendingReviewComments() {
    const reviews = this.pendingReviewThreads.map((thread) => thread.id);
    if (reviews.length === 0) return;
    this.closeChangeExplorer();
    await this.submitReviewComments(reviews);
  }

  private async submitReviewComments(threadIds: string[], instruction?: string) {
    const context = this.sessionContext();
    if (!context || threadIds.length === 0) return;
    const operationId = this.startOperation();
    this.reviewSubmissionsByOperation[operationId] = threadIds;
    const commentCount = this.reviewThreads
      .filter((thread) => threadIds.includes(thread.id))
      .reduce((count, thread) => count + thread.messages.filter((message) => message.role === "user" && !message.delivered).length, 0);
    this.reviewRuns.push({ operationId, ...context, threadIds: [...threadIds], commentCount: Math.max(commentCount, threadIds.length), status: "running" });
    try {
      await this.client.submitReviewThreads({ operationId, ...context, threadIds, instruction, model: this.session?.model ? { provider: this.session.model.provider, id: this.session.model.id } : undefined });
    } catch (error) {
      delete this.reviewSubmissionsByOperation[operationId];
      this.updateReviewRun(operationId, "error");
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  private updateReviewRun(operationId: string, status: ReviewRunState["status"]) {
    const index = this.reviewRuns.findIndex((run) => run.operationId === operationId);
    if (index < 0 || this.reviewRuns[index]!.status === status) return;
    this.reviewRuns.splice(index, 1, { ...this.reviewRuns[index]!, status });
  }

  private addPendingUserMessage(operationId: string, workspacePath: string, sessionId: string, text: string) {
    const earlierPendingCount = this.pendingUserMessages.filter((pending) =>
      pending.workspacePath === workspacePath && pending.sessionId === sessionId && pending.part.text === text
    ).length;
    this.pendingUserMessages.push({
      operationId,
      workspacePath,
      sessionId,
      canonicalPartCount: this.sessionCache.find(sessionId, workspacePath)?.uiParts.length ?? 0,
      expectedOccurrence: this.userMessageOccurrenceCount(workspacePath, sessionId, text) + earlierPendingCount + 1,
      part: { id: `optimistic-user-${operationId}`, kind: "text", role: "user", text, status: "complete" }
    });
  }

  private removePendingUserMessage(operationId: string) {
    const index = this.pendingUserMessages.findIndex((pending) => pending.operationId === operationId);
    if (index >= 0) this.pendingUserMessages.splice(index, 1);
  }

  private userMessageOccurrenceCount(workspacePath: string, sessionId: string, text: string) {
    return this.sessionCache.find(sessionId, workspacePath)?.uiParts.filter((part) =>
      part.kind === "text" && part.role === "user" && part.status === "complete" && part.text === text
    ).length ?? 0;
  }

  reconcilePendingUserMessages(sessionId: string) {
    for (let index = this.pendingUserMessages.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingUserMessages[index]!;
      if (pending.sessionId === sessionId && this.userMessageOccurrenceCount(pending.workspacePath, sessionId, pending.part.text) >= pending.expectedOccurrence) {
        this.pendingUserMessages.splice(index, 1);
      }
    }
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

  async selectModel(value: string) {
    const separator = value.indexOf("/");
    if (separator < 1) return;
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.setModel({ operationId, ...context, provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.setThinkingLevel({ operationId, ...context, level });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async setPiSetting(update: PiSettingUpdate) {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.setPiSetting({ operationId, ...context, update });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    if (this.providerOperation(provider)) return;
    const operationId = this.startOperation();
    this.providerOperations[operationId] = { provider, kind: "login" };
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.login({ operationId, ...context, provider, authType });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async logout(provider: string) {
    if (this.providerOperation(provider)) return;
    const operationId = this.startOperation();
    this.providerOperations[operationId] = { provider, kind: "logout" };
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.logout({ operationId, ...context, provider });
    } catch (error) {
      delete this.providerOperations[operationId];
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  providerOperation(provider: string) {
    return Object.values(this.providerOperations).find((operation) => operation.provider === provider)?.kind;
  }

  async respondToUi(value?: string, cancelled = false) {
    const request = this.uiRequest;
    if (!request) return;
    this.uiRequest = undefined;
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.respondToUi({ operationId: request.operationId, ...context, uiRequestId: request.uiRequestId, value, cancelled });
    } catch (error) {
      this.setError(error);
    }
  }

  async respondToArtifact(value?: unknown, cancelled = false) {
    const request = this.artifactRequest;
    if (!request) return;
    this.artifactRequest = undefined;
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.respondToArtifact({ operationId: request.operationId, ...context, artifactRequestId: request.artifactRequestId, value, cancelled });
    } catch (error) {
      this.setError(error);
    }
  }

  async exportArtifacts() {
    const context = this.sessionContext();
    if (!context) throw new Error("No active session");
    return this.client.exportArtifacts(context.workspacePath, context.sessionId);
  }

  dismissExtensionNotification(id: string) {
    const index = this.extensionNotifications.findIndex((item) => item.id === id);
    if (index >= 0) this.extensionNotifications.splice(index, 1);
  }

  private clearExtensionUi() {
    this.extensionTitle = undefined;
    this.extensionStatuses.splice(0);
    this.extensionWidgets.splice(0);
    this.extensionNotifications.splice(0);
    this.compatibilityDiagnostics.splice(0);
  }

  private applyExtensionUiState(state: ExtensionUiState) {
    this.extensionTitle = state.title;
    this.extensionStatuses.splice(0, this.extensionStatuses.length, ...state.statuses);
    this.extensionWidgets.splice(0, this.extensionWidgets.length, ...state.widgets);
  }

  private receiveExtensionUi(event: ExtensionUiEvent) {
    if (event.kind === "notify") {
      this.extensionNotifications.push(event);
      if (this.extensionNotifications.length > 8) this.extensionNotifications.splice(0, this.extensionNotifications.length - 8);
      return;
    }
    if (event.kind === "status") {
      const index = this.extensionStatuses.findIndex((item) => item.key === event.key);
      if (event.text === undefined) { if (index >= 0) this.extensionStatuses.splice(index, 1); }
      else if (index >= 0) this.extensionStatuses.splice(index, 1, { key: event.key, text: event.text });
      else this.extensionStatuses.push({ key: event.key, text: event.text });
      return;
    }
    if (event.kind === "title") { this.extensionTitle = event.title; return; }
    if (event.kind === "editor-text") { this.setDraft(event.mode === "insert" ? `${this.draft}${event.text}` : event.text); return; }
    if (event.kind === "widget") {
      const index = this.extensionWidgets.findIndex((item) => item.key === event.key);
      if (!event.lines) { if (index >= 0) this.extensionWidgets.splice(index, 1); }
      else {
        const widget = { key: event.key, lines: event.lines, placement: event.placement };
        if (index >= 0) this.extensionWidgets.splice(index, 1, widget); else this.extensionWidgets.push(widget);
      }
      return;
    }
    if (!this.compatibilityDiagnostics.some((item) => item.id === event.diagnostic.id)) this.compatibilityDiagnostics.push(event.diagnostic);
  }

  applySessionSnapshot(snapshot: SessionSnapshot, previousSessionId?: string) {
    const restartDraft = this.draftAfterAgentRestart;
    if (previousSessionId) this.draftsBySession[previousSessionId] = this.draft;
    this.projectPath = snapshot.workspacePath;
    this.selectedSessionId = snapshot.sessionId;
    this.markSessionRead(snapshot.workspacePath, snapshot.sessionId);
    this.draft = restartDraft ?? this.draftsBySession[snapshot.sessionId] ?? (previousSessionId ? "" : this.draft);
    this.draftAfterAgentRestart = undefined;
    this.draftsBySession[snapshot.sessionId] = this.draft;
    if (previousSessionId !== undefined) this.clearExtensionUi();
    this.applyExtensionUiState(snapshot.extensionUi);
    this.pendingOpen = undefined;
    const workspaceName = this.projects.find((project) => project.path === snapshot.workspacePath)?.name ?? this.nameFromPath(snapshot.workspacePath);
    const otherSessions = this.globalSessions.filter((session) => session.workspacePath !== snapshot.workspacePath);
    const workspaceSessions = snapshot.sessions.map((session) => ({ ...session, workspacePath: snapshot.workspacePath, workspaceName }));
    this.globalSessions.splice(0, this.globalSessions.length, ...otherSessions, ...workspaceSessions);
    this.globalSessions.sort((left, right) => right.modified.localeCompare(left.modified));
    if (!this.recentProjectPaths.includes(snapshot.workspacePath)) this.recentProjectPaths.push(snapshot.workspacePath);
    this.schedulePersist();
    void this.loadReviewThreads(snapshot.workspacePath, snapshot.sessionId);
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
        this.error = "Cake refused to mount history in a newly created session";
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
        this.activeOperations.splice(0);
        for (const operationId of Object.keys(this.providerOperations)) delete this.providerOperations[operationId];
        for (const operationId of Object.keys(this.reviewSubmissionsByOperation)) delete this.reviewSubmissionsByOperation[operationId];
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
        this.uiRequest = undefined;
        this.artifactRequest = undefined;
      }
      if (event.state === "ready" && this.reopenAfterAgentRestart && this.projectPath && this.session) {
        this.reopenAfterAgentRestart = false;
        void this.inspectPath(this.projectPath, false, this.session.sessionId, this.session.sessionFile);
      }
      return;
    }
    if (event.type === "workspace-inspected") {
      this.finishOperation(event.operationId);
      const pending = this.pendingOpen;
      if (!pending || pending.inspectOperationId !== event.operationId) return;
      if (event.trustRequired) this.pendingTrustPath = event.path;
      else {
        void this.openPath(event.path, pending.newSession, pending.sessionId, pending.sessionFile);
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
    if (event.type === "review-thread-streaming") {
      const index = this.reviewStreamingIds.indexOf(event.threadId);
      if (event.streaming && index < 0) this.reviewStreamingIds.push(event.threadId);
      if (!event.streaming && index >= 0) this.reviewStreamingIds.splice(index, 1);
      return;
    }
    if (event.type === "artifact-requested") {
      if (!this.activeOperations.includes(event.operationId) || !this.isActiveSession(event.record.workspacePath, event.record.artifact.sessionId)) return;
      this.artifactRequest = event;
      return;
    }
    if (event.type === "extension-ui-received") {
      if (event.sessionId === this.session?.sessionId) this.receiveExtensionUi(event.event);
      return;
    }
    if (event.type === "changes-received" && event.workspacePath === this.projectPath) {
      this.changedFiles.splice(0, this.changedFiles.length, ...event.files); this.changesLoading = false; this.finishOperation(event.operationId); return;
    }
    if (event.type === "changelog-received") {
      this.finishOperation(event.operationId);
      this.changelogLoading = false;
      if (!this.isActiveSession(event.workspacePath, event.sessionId)) return;
      this.changelogMarkdown = event.markdown;
      return;
    }
    if (event.type === "ui-requested") {
      if (!this.activeOperations.includes(event.operationId)) return;
      this.uiRequest = event;
      return;
    }
    if (event.type === "operation-completed") {
      delete this.providerOperations[event.operationId];
      if (this.reviewSubmissionsByOperation[event.operationId]) {
        const failed = this.reviewSubmissionsByOperation[event.operationId]!.some((threadId) => this.reviewThreads.find((thread) => thread.id === threadId)?.messages.at(-1)?.status === "error");
        this.updateReviewRun(event.operationId, failed ? "error" : "complete");
      }
      delete this.reviewSubmissionsByOperation[event.operationId];
      this.finishOperation(event.operationId);
      return;
    }
    if (event.type === "operation-failed") {
      if (event.operationId) delete this.providerOperations[event.operationId];
      if (event.operationId && this.reviewSubmissionsByOperation[event.operationId]) this.updateReviewRun(event.operationId, "error");
      if (event.operationId) delete this.reviewSubmissionsByOperation[event.operationId];
      if (event.operationId) this.removePendingUserMessage(event.operationId);
      if (event.operationId) this.finishOperation(event.operationId);
      if (event.operationId === this.activeOpenOperationId) {
        this.activeOpenOperationId = undefined;
        this.activeOpenTarget = undefined;
        this.activeOpenExpectsEmpty = false;
      }
      this.error = event.message;
    }
  }
}
