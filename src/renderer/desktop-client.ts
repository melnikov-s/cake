import type { CakeDesktopBridge, DesktopEvent } from "../ipc/desktop-ipc";
import type {
  Attachment,
  ApplicationState,
  ChangedFile,
  SessionSnapshot,
  ThinkingLevel,
  UiPart,
  WindowViewState
} from "../ipc/session-contract";

export type AgentState = "starting" | "ready" | "stopped" | "failed";

export type DesktopClientEvent =
  | { type: "agent-state-changed"; state: AgentState; workspacePath?: string }
  | { type: "workspace-inspected"; operationId: string; path: string; trustRequired: boolean }
  | { type: "session-snapshot-received"; operationId?: string; snapshot: SessionSnapshot }
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming-changed"; sessionId: string; streaming: boolean }
  | { type: "changes-received"; operationId: string; workspacePath: string; files: ChangedFile[] }
  | { type: "terminal-output"; workspacePath: string; terminalId: string; data: string }
  | { type: "terminal-exited"; workspacePath: string; terminalId: string; exitCode: number }
  | {
      type: "ui-requested";
      operationId: string;
      uiRequestId: string;
      kind: "confirm" | "text" | "secret" | "select" | "manual_code";
      title: string;
      message: string;
      placeholder?: string;
      options?: Array<{ id: string; label: string }>;
    }
  | { type: "operation-completed"; operationId: string }
  | { type: "operation-failed"; operationId?: string; message: string };

export interface DesktopClient {
  chooseProject(): Promise<string | undefined>;
  getHomeDirectory(): Promise<string>;
  chooseAttachments(): Promise<Attachment[]>;
  loadWindowState(): Promise<WindowViewState>;
  saveWindowState(state: WindowViewState): Promise<void>;
  loadApplicationState(): Promise<ApplicationState>;
  registerProject(path: string, name: string): Promise<ApplicationState>;
  renameProject(path: string, name: string): Promise<ApplicationState>;
  removeProject(path: string): Promise<ApplicationState>;
  archiveSession(path: string, sessionId: string, archived: boolean): Promise<ApplicationState>;
  createWindow(): Promise<void>;
  restartAgent(path: string): Promise<void>;
  inspectWorkspace(input: { operationId: string; path: string }): Promise<void>;
  openWorkspace(input: { operationId: string; path: string; trusted: boolean; newSession?: boolean; sessionId?: string; sessionFile?: string }): Promise<void>;
  submit(input: { operationId: string; workspacePath: string; sessionId: string; text: string; delivery: "prompt" | "steer" | "follow-up"; attachments: Attachment[] }): Promise<void>;
  abort(input: { operationId: string; workspacePath: string; sessionId: string }): Promise<void>;
  setModel(input: { operationId: string; workspacePath: string; sessionId: string; provider: string; modelId: string }): Promise<void>;
  setThinkingLevel(input: { operationId: string; workspacePath: string; sessionId: string; level: ThinkingLevel }): Promise<void>;
  login(input: { operationId: string; workspacePath: string; sessionId: string; provider: string; authType: "api_key" | "oauth" }): Promise<void>;
  logout(input: { operationId: string; workspacePath: string; sessionId: string; provider: string }): Promise<void>;
  renameSession(input: { operationId: string; workspacePath: string; sessionId: string; name: string }): Promise<void>;
  forkSession(input: { operationId: string; workspacePath: string; sessionId: string; entryId: string }): Promise<void>;
  navigateSession(input: { operationId: string; workspacePath: string; sessionId: string; entryId: string }): Promise<void>;
  inspectChanges(input: { operationId: string; workspacePath: string }): Promise<void>;
  terminalStart(input: { operationId: string; workspacePath: string; terminalId: string; cols: number; rows: number }): Promise<void>;
  terminalInput(input: { operationId: string; workspacePath: string; terminalId: string; data: string }): Promise<void>;
  terminalResize(input: { operationId: string; workspacePath: string; terminalId: string; cols: number; rows: number }): Promise<void>;
  terminalClose(input: { operationId: string; workspacePath: string; terminalId: string }): Promise<void>;
  respondToUi(input: { operationId: string; workspacePath: string; sessionId: string; uiRequestId: string; value?: string; cancelled: boolean }): Promise<void>;
  subscribe(listener: (event: DesktopClientEvent) => void): () => void;
}

function toClientEvent(event: DesktopEvent): DesktopClientEvent | undefined {
  if (event.type === "agent-state") return { type: "agent-state-changed", state: event.state, workspacePath: event.workspacePath };
  if (event.type === "workspace-inspected") return { type: "workspace-inspected", operationId: event.requestId, path: event.path, trustRequired: event.trustRequired };
  if (event.type === "session-snapshot") return { type: "session-snapshot-received", operationId: event.requestId, snapshot: event.snapshot };
  if (event.type === "part-updated" || event.type === "part-removed") return event;
  if (event.type === "session-streaming") return { type: "streaming-changed", sessionId: event.sessionId, streaming: event.streaming };
  if (event.type === "changes-snapshot") return { type: "changes-received", operationId: event.requestId, workspacePath: event.workspacePath, files: event.files };
  if (event.type === "terminal-output" || event.type === "terminal-exited") return event;
  if (event.type === "ui-request") return { type: "ui-requested", operationId: event.requestId, uiRequestId: event.uiRequestId, kind: event.kind, title: event.title, message: event.message, placeholder: event.placeholder, options: event.options };
  if (event.type === "complete") return { type: "operation-completed", operationId: event.requestId };
  if (event.type === "fatal" || event.type === "agent-error") return { type: "operation-failed", operationId: event.requestId, message: event.message };
  return undefined;
}

async function accept(bridge: CakeDesktopBridge, request: Parameters<CakeDesktopBridge["request"]>[0] & { requestId: string }) {
  const response = await bridge.request(request);
  if (response.type !== "accepted" || response.requestId !== request.requestId) throw new Error("Cake received a mismatched operation response");
}

export function createDesktopClient(bridge: CakeDesktopBridge): DesktopClient {
  return {
    async chooseProject() {
      const response = await bridge.request({ type: "choose-project" });
      if (response.type !== "project-chosen") throw new Error("Cake received an invalid project response");
      return response.path;
    },
    async getHomeDirectory() {
      const response = await bridge.request({ type: "get-home-directory" });
      if (response.type !== "home-directory") throw new Error("Cake could not resolve the home directory");
      return response.path;
    },
    async chooseAttachments() {
      const response = await bridge.request({ type: "choose-attachments" });
      if (response.type !== "attachments-chosen") throw new Error("Cake received an invalid attachment response");
      return response.attachments;
    },
    async loadWindowState() {
      const response = await bridge.request({ type: "load-window-state" });
      if (response.type !== "window-state-loaded") throw new Error("Cake received invalid window state");
      return response.state;
    },
    async saveWindowState(state) {
      const response = await bridge.request({ type: "save-window-state", state });
      if (response.type !== "window-state-saved") throw new Error("Cake could not persist window state");
    },
    async loadApplicationState() {
      const response = await bridge.request({ type: "load-application-state" });
      if (response.type !== "application-state-loaded") throw new Error("Cake received invalid application state");
      return response.state;
    },
    async registerProject(path, name) {
      const response = await bridge.request({ type: "register-project", path, name });
      if (response.type !== "application-state-updated") throw new Error("Cake could not register the project");
      return response.state;
    },
    async renameProject(path, name) {
      const response = await bridge.request({ type: "rename-project", path, name });
      if (response.type !== "application-state-updated") throw new Error("Cake could not rename the project");
      return response.state;
    },
    async removeProject(path) {
      const response = await bridge.request({ type: "remove-project", path });
      if (response.type !== "application-state-updated") throw new Error("Cake could not remove the project");
      return response.state;
    },
    async archiveSession(path, sessionId, archived) {
      const response = await bridge.request({ type: "archive-session", path, sessionId, archived });
      if (response.type !== "application-state-updated") throw new Error("Cake could not archive the session");
      return response.state;
    },
    async createWindow() {
      const response = await bridge.request({ type: "new-window" });
      if (response.type !== "window-created") throw new Error("Cake could not create a window");
    },
    async restartAgent(path) { await bridge.request({ type: "restart-agent", path }); },
    inspectWorkspace: (input) => accept(bridge, { type: "inspect-workspace", requestId: input.operationId, path: input.path }),
    openWorkspace: (input) => accept(bridge, { type: "open-workspace", requestId: input.operationId, path: input.path, trusted: input.trusted, newSession: input.newSession ?? false, sessionId: input.sessionId, sessionFile: input.sessionFile }),
    submit: (input) => accept(bridge, { type: "prompt", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, text: input.text, delivery: input.delivery, attachments: input.attachments }),
    abort: (input) => accept(bridge, { type: "abort", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId }),
    setModel: (input) => accept(bridge, { type: "set-model", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, provider: input.provider, modelId: input.modelId }),
    setThinkingLevel: (input) => accept(bridge, { type: "set-thinking", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, level: input.level }),
    login: (input) => accept(bridge, { type: "login", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, provider: input.provider, authType: input.authType }),
    logout: (input) => accept(bridge, { type: "logout", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, provider: input.provider }),
    renameSession: (input) => accept(bridge, { type: "rename-session", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, name: input.name }),
    forkSession: (input) => accept(bridge, { type: "fork-session", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, entryId: input.entryId }),
    navigateSession: (input) => accept(bridge, { type: "navigate-session", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, entryId: input.entryId }),
    inspectChanges: (input) => accept(bridge, { type: "inspect-changes", requestId: input.operationId, workspacePath: input.workspacePath }),
    terminalStart: (input) => accept(bridge, { type: "terminal-start", requestId: input.operationId, workspacePath: input.workspacePath, terminalId: input.terminalId, cols: input.cols, rows: input.rows }),
    terminalInput: (input) => accept(bridge, { type: "terminal-input", requestId: input.operationId, workspacePath: input.workspacePath, terminalId: input.terminalId, data: input.data }),
    terminalResize: (input) => accept(bridge, { type: "terminal-resize", requestId: input.operationId, workspacePath: input.workspacePath, terminalId: input.terminalId, cols: input.cols, rows: input.rows }),
    terminalClose: (input) => accept(bridge, { type: "terminal-close", requestId: input.operationId, workspacePath: input.workspacePath, terminalId: input.terminalId }),
    async respondToUi(input) {
      const response = await bridge.request({ type: "respond-ui", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, uiRequestId: input.uiRequestId, value: input.value, cancelled: input.cancelled });
      if (response.type !== "ui-response-accepted" || response.uiRequestId !== input.uiRequestId) throw new Error("Cake received a mismatched UI response");
    },
    subscribe(listener) {
      return bridge.subscribe((event) => {
        const mapped = toClientEvent(event);
        if (mapped) listener(mapped);
      });
    }
  };
}
