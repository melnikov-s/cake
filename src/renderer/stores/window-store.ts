import { Store, observable, untracked } from "r-state-tree";
import type {
  Attachment,
  ApplicationState,
  ChangedFile,
  ModelOption,
  ProjectRecord,
  SessionSnapshot,
  ThinkingLevel,
  WindowViewState
} from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent, PiState } from "../desktop-client";
import type { SessionModel } from "../models/session";

export interface UiRequestState {
  operationId: string;
  uiRequestId: string;
  kind: "confirm" | "text" | "secret" | "select" | "manual_code";
  title: string;
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string }>;
}

export class WindowStore extends Store<{ client: DesktopClient; session: SessionModel }> {
  readonly process = "renderer" as const;
  piState: PiState = "starting";
  hydrated = false;
  projectPath: string | undefined;
  selectedSessionId: string | undefined;
  recentProjectPaths: string[] = [];
  projects: ProjectRecord[] = [];
  trustedProjectPaths: string[] = [];
  pendingTrustPath: string | undefined;
  private pendingOpen: { inspectOperationId: string; path: string; newSession: boolean; sessionId?: string; sessionFile?: string } | undefined;
  private activeOpenOperationId: string | undefined;
  private activeOpenExpectsEmpty = false;
  draft = "";
  theme: "system" | "light" | "dark" = "system";
  attachments: Attachment[] = [];
  thinkingExpanded = false;
  sessionSearch = "";
  showArchived = false;
  commandPane: "changes" | "tree" | undefined;
  draftsBySession: Record<string, string> = observable({});
  changedFiles: ChangedFile[] = [];
  changesLoading = false;
  error: string | undefined;
  uiRequest: UiRequestState | undefined;
  activeOperations: string[] = [];
  private openRevision = 0;
  private reopenAfterAgentRestart = false;
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

  get session() {
    return this.props.session.loaded
      && this.props.session.sessionId === this.selectedSessionId
      && this.props.session.workspacePath === this.projectPath
      ? this.props.session
      : undefined;
  }

  get parts() {
    return this.session?.uiParts ?? [];
  }

  get isStreaming() {
    return this.session?.streaming ?? false;
  }

  get canSubmit() {
    return Boolean(this.session && this.draft.trim() && (this.isLocalSlashCommand || this.piState === "ready"));
  }

  get isLocalSlashCommand() {
    const command = this.draft.trim().toLocaleLowerCase();
    return command === "/tree" || command === "/changes";
  }

  get projectName() {
    return this.projectPath ? this.nameFromPath(this.projectPath) : "No workspace";
  }

  get currentSessions() {
    const query = this.sessionSearch.trim().toLocaleLowerCase();
    const archived = new Set(this.projects.find((project) => project.path === this.projectPath)?.archivedSessionIds ?? []);
    return (this.session?.sessions ?? [])
      .filter((item) => this.showArchived ? archived.has(item.id) : !archived.has(item.id))
      .filter((item) => !query || item.title.toLocaleLowerCase().includes(query));
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
      const [state, application] = await Promise.all([this.props.client.loadWindowState(), this.props.client.loadApplicationState()]);
      if (this.signal.aborted) return;
      this.applyApplicationState(application);
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
      if (state.projectPath) await this.inspectPath(state.projectPath);
    } catch (error) {
      if (this.signal.aborted) return;
      this.hydrated = true;
      this.setError(error);
    }
  }

  private viewState(): WindowViewState {
    return {
      projectPath: this.projectPath,
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
    const paths = state.projects.map((project) => project.path);
    for (const path of this.recentProjectPaths) if (!paths.includes(path)) paths.push(path);
    this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...paths);
  }

  private schedulePersist() {
    if (!this.hydrated) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.props.client.saveWindowState(this.viewState()).catch((error) => this.setError(error));
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
    const path = await this.props.client.chooseProject();
    if (path && !this.signal.aborted) await this.inspectPath(path);
  }

  async startOneOffChat() {
    try {
      const path = await this.props.client.getHomeDirectory();
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
    try { this.applyApplicationState(await this.props.client.renameProject(path, name)); }
    catch (error) { this.setError(error); }
  }

  async removeProject(path: string) {
    try {
      this.applyApplicationState(await this.props.client.removeProject(path));
      if (this.projectPath === path) {
        this.projectPath = undefined;
        this.selectedSessionId = undefined;
      }
      this.schedulePersist();
    } catch (error) { this.setError(error); }
  }

  async createWindow() {
    try { await this.props.client.createWindow(); }
    catch (error) { this.setError(error); }
  }

  async startNewSession() {
    if (!this.projectPath) {
      await this.chooseProject();
      return;
    }
    await this.inspectPath(this.projectPath, true);
  }

  async openSession(sessionId: string) {
    if (!this.projectPath || sessionId === this.session?.sessionId) return;
    await this.inspectPath(this.projectPath, false, sessionId);
  }

  private async inspectPath(path: string, newSession = false, sessionId?: string, sessionFile?: string) {
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.pendingOpen = { inspectOperationId: operationId, path, newSession, sessionId, sessionFile };
    try {
      await this.props.client.inspectWorkspace({ operationId, path });
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
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.activeOpenOperationId = operationId;
    this.activeOpenExpectsEmpty = newSession;
    this.selectedSessionId = undefined;
    this.uiRequest = undefined;
    this.commandPane = undefined;
    try {
      await this.props.client.openWorkspace({ operationId, path, trusted, newSession, sessionId, sessionFile });
      void this.props.client.registerProject(path, this.nameFromPath(path)).then((state) => this.applyApplicationState(state)).catch((error) => this.setError(error));
    } catch (error) {
      if (revision === this.openRevision) this.setError(error);
      if (this.activeOpenOperationId === operationId) {
        this.activeOpenOperationId = undefined;
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
  toggleArchived() { this.showArchived = !this.showArchived; }

  async openCommandPane(pane: "changes" | "tree") {
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
    try { await this.props.client.inspectChanges({ operationId, workspacePath: this.projectPath }); }
    catch (error) { this.changesLoading = false; this.finishOperation(operationId); this.setError(error); }
  }

  async renameCurrentSession(name: string) {
    const context = this.sessionContext(); if (!context || !name.trim()) return;
    const operationId = this.startOperation();
    try { await this.props.client.renameSession({ operationId, ...context, name: name.trim() }); }
    catch (error) { this.finishOperation(operationId); this.setError(error); }
  }

  async archiveSession(sessionId: string, archived: boolean) {
    if (!this.projectPath) return;
    try { this.applyApplicationState(await this.props.client.archiveSession(this.projectPath, sessionId, archived)); }
    catch (error) { this.setError(error); }
  }

  async forkAt(entryId: string) {
    const context = this.sessionContext(); if (!context) return;
    this.closeCommandPane();
    const operationId = this.startOperation(); this.activeOpenOperationId = operationId;
    try { await this.props.client.forkSession({ operationId, ...context, entryId }); }
    catch (error) { this.finishOperation(operationId); this.setError(error); }
  }

  async navigateTo(entryId: string) {
    const context = this.sessionContext(); if (!context) return;
    this.closeCommandPane();
    const operationId = this.startOperation();
    try { await this.props.client.navigateSession({ operationId, ...context, entryId }); }
    catch (error) { this.finishOperation(operationId); this.setError(error); }
  }

  async restartPi() {
    if (!this.projectPath) return;
    try { await this.props.client.restartPi(this.projectPath); }
    catch (error) { this.setError(error); }
  }

  async addAttachments() {
    try {
      const selected = await this.props.client.chooseAttachments();
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
    if (command === "/tree" || command === "/changes") {
      this.setDraft("");
      await this.openCommandPane(command === "/tree" ? "tree" : "changes");
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
      await this.props.client.submit({ operationId, ...context, text, delivery, attachments });
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
      await this.props.client.abort({ operationId, ...context });
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
      await this.props.client.setModel({ operationId, ...context, provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.props.client.setThinkingLevel({ operationId, ...context, level });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.props.client.login({ operationId, ...context, provider, authType });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async logout(provider: string) {
    const operationId = this.startOperation();
    try {
      const context = this.sessionContext(); if (!context) throw new Error("No active session");
      await this.props.client.logout({ operationId, ...context, provider });
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
      await this.props.client.respondToUi({ operationId: request.operationId, ...context, uiRequestId: request.uiRequestId, value, cancelled });
    } catch (error) {
      this.setError(error);
    }
  }

  applySessionSnapshot(snapshot: SessionSnapshot, previousSessionId?: string) {
    if (previousSessionId) this.draftsBySession[previousSessionId] = this.draft;
    this.projectPath = snapshot.workspacePath;
    this.selectedSessionId = snapshot.sessionId;
    this.draft = this.draftsBySession[snapshot.sessionId] ?? (previousSessionId ? "" : this.draft);
    this.draftsBySession[snapshot.sessionId] = this.draft;
    this.pendingOpen = undefined;
    const existing = this.recentProjectPaths.indexOf(snapshot.workspacePath);
    if (existing >= 0) this.recentProjectPaths.splice(existing, 1);
    this.recentProjectPaths.unshift(snapshot.workspacePath);
    if (this.recentProjectPaths.length > 12) this.recentProjectPaths.splice(12);
    this.schedulePersist();
  }

  acceptSessionSnapshot(event: Extract<DesktopClientEvent, { type: "session-snapshot-received" }>) {
    if (event.operationId) {
      if (event.operationId !== this.activeOpenOperationId) {
        this.finishOperation(event.operationId);
        return false;
      }
      if (this.activeOpenExpectsEmpty && event.snapshot.parts.length > 0) {
        this.activeOpenOperationId = undefined;
        this.activeOpenExpectsEmpty = false;
        this.finishOperation(event.operationId);
        this.error = "Cake refused to mount history in a newly created session";
        return false;
      }
      this.activeOpenOperationId = undefined;
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
        this.activeOperations.splice(0);
        this.uiRequest = undefined;
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
      this.error = event.message;
    }
  }
}
