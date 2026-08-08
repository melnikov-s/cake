import { Store, createStore, mount, untracked } from "r-state-tree";
import type {
  Attachment,
  ModelOption,
  SessionSnapshot,
  ThinkingLevel,
  UiPart,
  WindowViewState
} from "../../ipc/session-contract";
import type { AgentState, DesktopClient, DesktopClientEvent } from "../desktop-client";

export interface UiRequestState {
  operationId: string;
  uiRequestId: string;
  kind: "confirm" | "text" | "secret" | "select" | "manual_code";
  title: string;
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string }>;
}

export class WindowStore extends Store<{ client: DesktopClient }> {
  readonly process = "renderer" as const;
  agentState: AgentState = "starting";
  hydrated = false;
  projectPath: string | undefined;
  recentProjectPaths: string[] = [];
  trustedProjectPaths: string[] = [];
  pendingTrustPath: string | undefined;
  private pendingOpen: { inspectOperationId: string; path: string; newSession: boolean; sessionId?: string } | undefined;
  private activeOpenOperationId: string | undefined;
  private activeOpenExpectsEmpty = false;
  session: SessionSnapshot | undefined;
  parts: UiPart[] = [];
  draft = "";
  theme: "system" | "light" | "dark" = "system";
  attachments: Attachment[] = [];
  thinkingExpanded = false;
  error: string | undefined;
  uiRequest: UiRequestState | undefined;
  activeOperations: string[] = [];
  private openRevision = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: WindowStore["props"]) {
    super(props);
    this.effect(() => this.props.client.subscribe((event) => this.receive(event)));
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

  get isStreaming() {
    return this.session?.streaming ?? false;
  }

  get canSubmit() {
    return Boolean(this.session && this.draft.trim() && this.agentState === "ready");
  }

  get projectName() {
    return this.projectPath ? this.nameFromPath(this.projectPath) : "No workspace";
  }

  get currentSessions() {
    return this.session?.sessions ?? [];
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
      const state = await this.props.client.loadWindowState();
      if (this.signal.aborted) return;
      this.projectPath = state.projectPath;
      this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...state.recentProjectPaths);
      this.trustedProjectPaths.splice(0, this.trustedProjectPaths.length, ...state.trustedProjectPaths);
      this.draft = state.draft;
      this.theme = state.theme;
      this.thinkingExpanded = state.thinkingExpanded;
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
      thinkingExpanded: this.thinkingExpanded
    };
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

  private async inspectPath(path: string, newSession = false, sessionId?: string) {
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.pendingOpen = { inspectOperationId: operationId, path, newSession, sessionId };
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
    await this.openPath(pending.path, true, pending.newSession, pending.sessionId);
  }

  private async openPath(path: string, trusted: boolean, newSession = false, sessionId?: string) {
    const revision = ++this.openRevision;
    const operationId = this.startOperation();
    this.activeOpenOperationId = operationId;
    this.activeOpenExpectsEmpty = newSession;
    this.session = undefined;
    this.parts.splice(0);
    this.uiRequest = undefined;
    try {
      await this.props.client.openWorkspace({ operationId, path, trusted, newSession, sessionId });
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
    const delivery = deliveryOverride ?? (this.isStreaming ? "follow-up" : "prompt");
    const attachments = this.attachments.slice();
    const operationId = this.startOperation();
    this.draft = "";
    this.attachments.splice(0);
    this.schedulePersist();
    try {
      await this.props.client.submit({ operationId, text, delivery, attachments });
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
      await this.props.client.abort(operationId);
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
      await this.props.client.setModel({ operationId, provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async selectThinkingLevel(level: ThinkingLevel) {
    const operationId = this.startOperation();
    try {
      await this.props.client.setThinkingLevel({ operationId, level });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async authenticate(provider: string, authType: "api_key" | "oauth") {
    const operationId = this.startOperation();
    try {
      await this.props.client.login({ operationId, provider, authType });
    } catch (error) {
      this.setError(error);
      this.finishOperation(operationId);
    }
  }

  async logout(provider: string) {
    const operationId = this.startOperation();
    try {
      await this.props.client.logout({ operationId, provider });
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
      await this.props.client.respondToUi({ operationId: request.operationId, uiRequestId: request.uiRequestId, value, cancelled });
    } catch (error) {
      this.setError(error);
    }
  }

  private applySnapshot(snapshot: SessionSnapshot) {
    this.session = snapshot;
    this.parts.splice(0, this.parts.length, ...snapshot.parts);
    this.projectPath = snapshot.workspacePath;
    this.pendingOpen = undefined;
    const existing = this.recentProjectPaths.indexOf(snapshot.workspacePath);
    if (existing >= 0) this.recentProjectPaths.splice(existing, 1);
    this.recentProjectPaths.unshift(snapshot.workspacePath);
    if (this.recentProjectPaths.length > 12) this.recentProjectPaths.splice(12);
    this.schedulePersist();
  }

  private upsertPart(part: UiPart) {
    const index = this.parts.findIndex((current) => current.id === part.id);
    if (index < 0) this.parts.push(part);
    else {
      const existing = this.parts[index];
      this.parts.splice(index, 1, existing?.kind === "tool" && part.kind === "tool"
        ? { ...part, input: part.input || existing.input }
        : part);
    }
  }

  private receive(event: DesktopClientEvent) {
    if (event.type === "agent-state-changed") {
      this.agentState = event.state;
      if (event.state === "failed" || event.state === "stopped") {
        this.activeOperations.splice(0);
        this.uiRequest = undefined;
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
        void this.openPath(event.path, trusted, pending.newSession, pending.sessionId);
      }
      return;
    }
    if (event.type === "session-snapshot-received") {
      if (event.operationId) {
        if (event.operationId !== this.activeOpenOperationId) {
          this.finishOperation(event.operationId);
          return;
        }
        if (this.activeOpenExpectsEmpty && event.snapshot.parts.length > 0) {
          this.activeOpenOperationId = undefined;
          this.activeOpenExpectsEmpty = false;
          this.finishOperation(event.operationId);
          this.error = "Cake refused to mount history in a newly created session";
          return;
        }
        this.activeOpenOperationId = undefined;
        this.activeOpenExpectsEmpty = false;
      } else if (!this.session || event.snapshot.sessionId !== this.session.sessionId || event.snapshot.workspacePath !== this.session.workspacePath) {
        return;
      }
      this.applySnapshot(event.snapshot);
      if (event.operationId) this.finishOperation(event.operationId);
      return;
    }
    if (event.type === "part-updated" && event.sessionId === this.session?.sessionId) {
      this.upsertPart(event.part);
      return;
    }
    if (event.type === "part-removed" && event.sessionId === this.session?.sessionId) {
      const index = this.parts.findIndex((part) => part.id === event.partId);
      if (index >= 0) this.parts.splice(index, 1);
      return;
    }
    if (event.type === "streaming-changed" && event.sessionId === this.session?.sessionId && this.session) {
      this.session = { ...this.session, streaming: event.streaming };
      return;
    }
    if (event.type === "ui-requested") {
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

export function mountWindowStore(client: DesktopClient) {
  return mount(createStore(WindowStore, { client }));
}
