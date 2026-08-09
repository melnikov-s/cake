import { Store, observable, untracked } from "r-state-tree";
import type {
  Attachment,
  ApplicationState,
  ChangedFile,
  ExtensionUiEvent,
  ExtensionUiState,
  GlobalSessionSummary,
  ModelOption,
  ProjectRecord,
  ResourceDiagnostic,
  SessionSnapshot,
  ThinkingLevel,
  WindowViewState
} from "../../ipc/session-contract";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { DesktopClientEvent, PiState } from "../desktop-client";
import { DesktopClientContext, SessionCacheContext } from "./context";

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

export class WindowStore extends Store<Record<string, never>> {
  readonly process = "renderer" as const;
  piState: PiState = "starting";
  hydrated = false;
  projectPath: string | undefined;
  selectedSessionId: string | undefined;
  recentProjectPaths: string[] = [];
  projects: ProjectRecord[] = [];
  globalSessions: GlobalSessionSummary[] = observable([]);
  trustedProjectPaths: string[] = [];
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
  commandPane: "changes" | "tree" | "resources" | undefined;
  draftsBySession: Record<string, string> = observable({});
  sessionLimitsByProject: Record<string, number> = observable({});
  changedFiles: ChangedFile[] = [];
  changesLoading = false;
  error: string | undefined;
  uiRequest: UiRequestState | undefined;
  artifactRequest: ArtifactRequestState | undefined;
  extensionTitle: string | undefined;
  extensionStatuses: ExtensionUiState["statuses"] = observable([]);
  extensionWidgets: ExtensionUiState["widgets"] = observable([]);
  extensionNotifications: ExtensionNotification[] = observable([]);
  compatibilityDiagnostics: ResourceDiagnostic[] = observable([]);
  activeOperations: string[] = [];
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

  get session() {
    return this.selectedSessionId && this.projectPath
      ? this.sessionCache.find(this.selectedSessionId, this.projectPath)
      : undefined;
  }

  get parts() {
    return this.session?.uiParts ?? [];
  }

  get artifacts() {
    return this.session?.artifacts.map((artifact) => artifact.value) ?? [];
  }

  get isStreaming() {
    return this.session?.streaming ?? false;
  }

  get canSubmit() {
    return Boolean(this.session && !this.activeOpenOperationId && this.draft.trim() && (this.isLocalSlashCommand || this.piState === "ready"));
  }

  get isLocalSlashCommand() {
    const command = this.draft.trim().toLocaleLowerCase();
    return command === "/tree" || command === "/changes" || command === "/resources";
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

  private async hydrate() {
    try {
      const [state, application, sessions] = await Promise.all([this.client.loadWindowState(), this.client.loadApplicationState(), this.client.listSessions()]);
      if (this.signal.aborted) return;
      this.applyApplicationState(application);
      this.globalSessions.splice(0, this.globalSessions.length, ...sessions);
      this.projectPath = state.projectPath;
      this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...state.recentProjectPaths);
      this.trustedProjectPaths.splice(0, this.trustedProjectPaths.length, ...state.trustedProjectPaths);
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
      trustedProjectPaths: this.trustedProjectPaths.slice(),
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
    await this.openPath(this.projectPath, this.trustedProjectPaths.includes(this.projectPath), true);
  }

  async openSession(workspacePath: string, sessionId: string) {
    if (workspacePath === this.projectPath && sessionId === this.session?.sessionId) return;
    const sameWorkspace = workspacePath === this.projectPath;
    const cached = this.showCachedSession(workspacePath, sessionId);
    if (!cached) void this.loadSessionPreview(workspacePath, sessionId);
    if (sameWorkspace) await this.openPath(workspacePath, this.trustedProjectPaths.includes(workspacePath), false, sessionId);
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
    this.draft = this.draftsBySession[sessionId] ?? "";
    this.clearExtensionUi();
    this.commandPane = undefined;
    this.schedulePersist();
    return true;
  }

  private async inspectPath(path: string, newSession = false, sessionId?: string, sessionFile?: string) {
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.clearExtensionUi();
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
    if (!trusted) {
      this.pendingOpen = undefined;
      return;
    }
    if (!this.trustedProjectPaths.includes(pending.path)) this.trustedProjectPaths.push(pending.path);
    if (this.trustedProjectPaths.length > 100) this.trustedProjectPaths.splice(0, this.trustedProjectPaths.length - 100);
    this.schedulePersist();
    await this.openPath(pending.path, true, pending.newSession, pending.sessionId, pending.sessionFile);
  }

  private async openPath(path: string, trusted: boolean, newSession = false, sessionId?: string, sessionFile?: string) {
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
    try {
      await this.client.openWorkspace({ operationId, path, trusted, newSession, sessionId, sessionFile });
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

  async openCommandPane(pane: "changes" | "tree" | "resources") {
    this.commandPane = pane;
    if (pane === "changes") await this.refreshChanges();
  }

  closeCommandPane() { this.commandPane = undefined; }

  private sessionContext() {
    if (!this.projectPath || !this.session) return undefined;
    return { workspacePath: this.projectPath, sessionId: this.session.sessionId };
  }

  async refreshChanges() {
    if (!this.projectPath || this.changesLoading) return;
    const operationId = this.startOperation(); this.changesLoading = true;
    try { await this.client.inspectChanges({ operationId, workspacePath: this.projectPath }); }
    catch (error) { this.changesLoading = false; this.finishOperation(operationId); this.setError(error); }
  }

  async renameCurrentSession(name: string) {
    const context = this.sessionContext(); if (!context || !name.trim()) return;
    const operationId = this.startOperation();
    try { await this.client.renameSession({ operationId, ...context, name: name.trim() }); }
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
    this.closeCommandPane();
    const operationId = this.startOperation();
    try { await this.client.navigateSession({ operationId, ...context, entryId }); }
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
      this.attachments.push(...selected.filter((item) => !this.attachments.some((current) => current.kind === item.kind && current.name === item.name)));
    } catch (error) {
      this.setError(error);
    }
  }

  removeAttachment(index: number) {
    this.attachments.splice(index, 1);
  }

  async submit(deliveryOverride?: "steer") {
    if (!this.canSubmit) return;
    const text = this.draft.trim();
    const command = text.toLocaleLowerCase();
    if (command === "/tree" || command === "/changes" || command === "/resources") {
      this.setDraft("");
      await this.openCommandPane(command === "/tree" ? "tree" : command === "/changes" ? "changes" : "resources");
      return;
    }
    const delivery = deliveryOverride ?? (this.isStreaming ? "follow-up" : "prompt");
    const attachments = this.attachments.slice();
    const operationId = this.startOperation();
    this.draft = "";
    this.attachments.splice(0);
    this.schedulePersist();
    try {
      const context = this.sessionContext();
      if (!context) throw new Error("No active session");
      await this.client.submit({ operationId, ...context, text, delivery, attachments });
    } catch (error) {
      this.setError(error);
      this.draft = text;
      this.attachments.push(...attachments);
      this.finishOperation(operationId);
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

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.login({ operationId, ...context, provider, authType });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async logout(provider: string) {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.client.logout({ operationId, ...context, provider });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
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
      if (event.trustRequired && !this.trustedProjectPaths.includes(event.path)) this.pendingTrustPath = event.path;
      else {
        const trusted = event.trustRequired && this.trustedProjectPaths.includes(event.path);
        void this.openPath(event.path, trusted, pending.newSession, pending.sessionId, pending.sessionFile);
      }
      return;
    }
    if (event.type === "session-snapshot-received" || event.type === "part-updated" || event.type === "part-removed" || event.type === "streaming-changed") return;
    if (event.type === "artifact-updated") return;
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
    if (event.type === "ui-requested") {
      if (!this.activeOperations.includes(event.operationId)) return;
      this.uiRequest = event;
      return;
    }
    if (event.type === "operation-completed") {
      this.finishOperation(event.operationId);
      return;
    }
    if (event.type === "operation-failed") {
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
