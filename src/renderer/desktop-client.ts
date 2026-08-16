import type { CakeDesktopBridge, DesktopEvent } from "../ipc/desktop-ipc";
import type {
  Attachment,
  ApplicationState,
  ChangedFile,
  FileSuggestion,
  GlobalSessionSummary,
  SessionSnapshot,
  SessionPreview,
  PiSettingUpdate,
  ThinkingLevel,
  ExtensionUiEvent,
  UiPart,
  WindowViewState
} from "../ipc/session-contract";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { ReviewAnchor, ReviewThread } from "../ipc/review-contract";
import type { CustomizationState, PluginDiagnostic, PluginStatus } from "../plugin/plugin-contract";
import type { CompiledInlineWidget, InlineWidgetCapability, InlineWidgetLanguage, RepairedInlineWidget } from "../ipc/inline-widget-contract";

export type PiState = "starting" | "ready" | "stopped" | "failed";

export type DesktopClientEvent =
  | { type: "pi-state-changed"; state: PiState; workspacePath?: string }
  | { type: "workspace-inspected"; operationId: string; path: string; trustRequired: boolean }
  | { type: "session-snapshot-received"; operationId?: string; snapshot: SessionSnapshot }
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming-changed"; sessionId: string; streaming: boolean }
  | { type: "global-chat-snapshot-received"; operationId?: string; snapshot: SessionSnapshot }
  | { type: "global-chat-part-updated"; part: UiPart }
  | { type: "global-chat-part-removed"; partId: string }
  | { type: "global-chat-streaming-changed"; streaming: boolean }
  | { type: "global-chat-operation-completed"; operationId: string }
  | { type: "global-chat-operation-failed"; operationId: string; message: string }
  | { type: "global-chat-control-requested"; controlRequestId: string; invocation: { name: string; arguments: unknown } }
  | { type: "extension-ui-received"; sessionId: string; event: ExtensionUiEvent }
  | { type: "changes-received"; operationId: string; workspacePath: string; sessionId: string; files: ChangedFile[] }
  | { type: "changelog-received"; operationId: string; workspacePath: string; sessionId: string; markdown: string }
  | { type: "artifact-updated"; record: ArtifactRecord }
  | { type: "artifact-requested"; operationId: string; artifactRequestId: string; record: ArtifactRecord }
  | { type: "review-threads-received"; workspacePath: string; sessionId: string; threads: ReviewThread[] }
  | { type: "review-thread-updated"; thread: ReviewThread }
  | { type: "review-thread-streaming"; workspacePath: string; sessionId: string; threadId: string; streaming: boolean }
  | {
      type: "ui-requested";
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
  | { type: "operation-completed"; operationId: string }
  | { type: "operation-failed"; operationId?: string; message: string }
  | { type: "customization-state-changed"; state: CustomizationState };

export interface DesktopClient {
  chooseProject(): Promise<string | undefined>;
  getHomeDirectory(): Promise<string>;
  getCustomizationState(): Promise<CustomizationState>;
  listCustomizationFiles(): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  readCustomizationFile(path: string): Promise<string>;
  writeCustomizationFile(path: string, content: string, expectedWorkingRevision: string): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  buildCustomization(expectedBaseRevision?: string, request?: string, expectedSourceRevision?: string): Promise<{ revision: string; diagnostics: PluginDiagnostic[]; activating: boolean }>;
  rollbackCustomization(): Promise<CustomizationState>;
  useFactoryCustomization(): Promise<CustomizationState>;
  listPlugins(): Promise<PluginStatus[]>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginStatus[]>;
  chooseAttachments(): Promise<Attachment[]>;
  suggestFiles(workspacePath: string, prefix: string): Promise<FileSuggestion[]>;
  listWorkspaceFiles(workspacePath: string): Promise<string[]>;
  readWorkspaceFile(workspacePath: string, path: string): Promise<string>;
  compileInlineWidget(language: InlineWidgetLanguage, source: string, capability: InlineWidgetCapability): Promise<CompiledInlineWidget>;
  repairInlineWidget(input: { workspacePath: string; sessionId: string; language: InlineWidgetLanguage; capability: InlineWidgetCapability; source: string; context: string; diagnostic?: string; model?: { provider: string; id: string } }): Promise<RepairedInlineWidget>;
  loadWindowState(): Promise<WindowViewState>;
  saveWindowState(state: WindowViewState): Promise<void>;
  loadApplicationState(): Promise<ApplicationState>;
  listSessions(): Promise<{ sessions: GlobalSessionSummary[]; reviewThreads: ReviewThread[] }>;
  loadSession(workspacePath: string, sessionId: string): Promise<SessionPreview | undefined>;
  openGlobalChat(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> }): Promise<void>;
  promptGlobalChat(input: { operationId: string; text: string }): Promise<void>;
  abortGlobalChat(operationId: string): Promise<void>;
  clearGlobalChat(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string; parameters: Record<string, unknown> }> }): Promise<void>;
  setGlobalChatModel(input: { operationId: string; provider: string; modelId: string }): Promise<void>;
  setGlobalChatThinkingLevel(input: { operationId: string; level: ThinkingLevel }): Promise<void>;
  respondToGlobalChatControl(controlRequestId: string, result: unknown): Promise<void>;
  listReviewThreads(workspacePath: string, sessionId: string): Promise<ReviewThread[]>;
  createReviewThread(input: { workspacePath: string; sessionId: string; anchor: ReviewAnchor; body: string }): Promise<ReviewThread>;
  replyReviewThread(input: { workspacePath: string; sessionId: string; threadId: string; body: string }): Promise<ReviewThread>;
  resolveReviewThread(input: { workspacePath: string; sessionId: string; threadId: string; resolved: boolean }): Promise<ReviewThread>;
  submitReviewThreads(input: { operationId: string; workspacePath: string; sessionId: string; threadIds: string[]; commentCount: number; instruction?: string; model?: { provider: string; id: string } }): Promise<void>;
  registerProject(path: string, name: string): Promise<ApplicationState>;
  renameProject(path: string, name: string): Promise<ApplicationState>;
  removeProject(path: string): Promise<ApplicationState>;
  archiveSession(path: string, sessionId: string, archived: boolean): Promise<ApplicationState>;
  createWindow(): Promise<void>;
  restartPi(path: string): Promise<void>;
  inspectWorkspace(input: { operationId: string; path: string }): Promise<void>;
  respondToWorkspaceTrust(input: { operationId: string; path: string; approved: boolean }): Promise<void>;
  openWorkspace(input: { operationId: string; path: string; newSession?: boolean; sessionId?: string }): Promise<void>;
  submit(input: { operationId: string; workspacePath: string; sessionId: string; text: string; delivery: "prompt" | "steer" | "follow-up"; attachments: Attachment[] }): Promise<void>;
  abort(input: { operationId: string; workspacePath: string; sessionId: string }): Promise<void>;
  setModel(input: { operationId: string; workspacePath: string; sessionId: string; provider: string; modelId: string }): Promise<void>;
  setThinkingLevel(input: { operationId: string; workspacePath: string; sessionId: string; level: ThinkingLevel }): Promise<void>;
  setPiSetting(input: { operationId: string; workspacePath: string; sessionId: string; update: PiSettingUpdate }): Promise<void>;
  reloadPi(input: { operationId: string; workspacePath: string; sessionId: string }): Promise<void>;
  login(input: { operationId: string; workspacePath: string; sessionId: string; provider: string; authType: "api_key" | "oauth" }): Promise<void>;
  logout(input: { operationId: string; workspacePath: string; sessionId: string; provider: string }): Promise<void>;
  renameSession(input: { operationId: string; workspacePath: string; sessionId: string; name: string }): Promise<void>;
  forkSession(input: { operationId: string; workspacePath: string; sessionId: string; entryId: string }): Promise<void>;
  navigateSession(input: { operationId: string; workspacePath: string; sessionId: string; entryId: string }): Promise<void>;
  inspectChanges(input: { operationId: string; workspacePath: string; sessionId: string }): Promise<void>;
  getChangelog(input: { operationId: string; workspacePath: string; sessionId: string }): Promise<void>;
  respondToUi(input: { operationId: string; workspacePath: string; sessionId: string; uiRequestId: string; value?: string; cancelled: boolean }): Promise<void>;
  respondToArtifact(input: { operationId: string; workspacePath: string; sessionId: string; artifactRequestId: string; value?: unknown; cancelled: boolean }): Promise<void>;
  exportArtifacts(workspacePath: string, sessionId: string): Promise<string>;
  subscribe(listener: (event: DesktopClientEvent) => void): () => void;
}

function toClientEvent(event: DesktopEvent): DesktopClientEvent | undefined {
  if (event.type === "pi-state") return { type: "pi-state-changed", state: event.state, workspacePath: event.workspacePath };
  if (event.type === "workspace-inspected") return { type: "workspace-inspected", operationId: event.requestId, path: event.path, trustRequired: event.trustRequired };
  if (event.type === "session-snapshot") return { type: "session-snapshot-received", operationId: event.requestId, snapshot: event.snapshot };
  if (event.type === "part-updated" || event.type === "part-removed") return event;
  if (event.type === "session-streaming") return { type: "streaming-changed", sessionId: event.sessionId, streaming: event.streaming };
  if (event.type === "global-chat-snapshot") return { type: "global-chat-snapshot-received", operationId: event.requestId, snapshot: event.snapshot };
  if (event.type === "global-chat-part-updated" || event.type === "global-chat-part-removed") return event;
  if (event.type === "global-chat-streaming") return { type: "global-chat-streaming-changed", streaming: event.streaming };
  if (event.type === "global-chat-operation-completed") return { type: event.type, operationId: event.requestId };
  if (event.type === "global-chat-operation-failed") return { type: event.type, operationId: event.requestId, message: event.message };
  if (event.type === "global-chat-control-request") return { type: "global-chat-control-requested", controlRequestId: event.controlRequestId, invocation: event.invocation };
  if (event.type === "extension-ui") return { type: "extension-ui-received", sessionId: event.sessionId, event: event.event };
  if (event.type === "artifact-updated") return event;
  if (event.type === "artifact-requested") return { type: "artifact-requested", operationId: event.requestId, artifactRequestId: event.artifactRequestId, record: event.record };
  if (event.type === "review-threads-snapshot") return { type: "review-threads-received", workspacePath: event.workspacePath, sessionId: event.sessionId, threads: event.threads };
  if (event.type === "review-thread-updated" || event.type === "review-thread-streaming") return event;
  if (event.type === "changes-snapshot") return { type: "changes-received", operationId: event.requestId, workspacePath: event.workspacePath, sessionId: event.sessionId, files: event.files };
  if (event.type === "changelog-snapshot") return { type: "changelog-received", operationId: event.requestId, workspacePath: event.workspacePath, sessionId: event.sessionId, markdown: event.markdown };
  if (event.type === "ui-request") return { type: "ui-requested", operationId: event.requestId, uiRequestId: event.uiRequestId, kind: event.kind, title: event.title, message: event.message, placeholder: event.placeholder, initialValue: event.initialValue, multiline: event.multiline, options: event.options };
  if (event.type === "complete") return { type: "operation-completed", operationId: event.requestId };
  if (event.type === "fatal") return { type: "operation-failed", operationId: event.requestId, message: event.message };
  if (event.type === "customization-state-changed") return event;
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
    async getCustomizationState() {
      const response = await bridge.request({ type: "get-customization-state" });
      if (response.type !== "customization-state") throw new Error("Cake received invalid customization state");
      return response.state;
    },
    async listCustomizationFiles() {
      const response = await bridge.request({ type: "list-customization-files" });
      if (response.type !== "customization-files") throw new Error("Cake returned invalid customization files");
      return response;
    },
    async readCustomizationFile(path) {
      const response = await bridge.request({ type: "read-customization-file", path });
      if (response.type !== "customization-file") throw new Error("Cake returned invalid customization source");
      return response.content;
    },
    async writeCustomizationFile(path, content, expectedWorkingRevision) {
      const response = await bridge.request({ type: "write-customization-file", path, content, expectedWorkingRevision });
      if (response.type !== "customization-files") throw new Error("Cake returned invalid customization files");
      return response;
    },
    async buildCustomization(expectedBaseRevision, request, expectedSourceRevision) {
      const response = await bridge.request({ type: "build-customization", expectedBaseRevision, expectedSourceRevision, request });
      if (response.type !== "customization-build") throw new Error("Cake received invalid customization build results");
      return response;
    },
    async rollbackCustomization() {
      const response = await bridge.request({ type: "rollback-customization" });
      if (response.type !== "customization-state") throw new Error("Cake could not roll back customization");
      return response.state;
    },
    async useFactoryCustomization() {
      const response = await bridge.request({ type: "use-factory-customization" });
      if (response.type !== "customization-state") throw new Error("Cake could not switch to the factory scene");
      return response.state;
    },
    async listPlugins() {
      const response = await bridge.request({ type: "list-plugins" });
      if (response.type !== "plugins-listed") throw new Error("Cake received an invalid plugin list");
      return response.plugins;
    },
    async setPluginEnabled(pluginId, enabled) {
      const response = await bridge.request({ type: "set-plugin-enabled", pluginId, enabled });
      if (response.type !== "plugins-listed") throw new Error("Cake could not update the plugin");
      return response.plugins;
    },
    async chooseAttachments() {
      const response = await bridge.request({ type: "choose-attachments" });
      if (response.type !== "attachments-chosen") throw new Error("Cake received an invalid attachment response");
      return response.attachments;
    },
    async suggestFiles(workspacePath, prefix) {
      const response = await bridge.request({ type: "suggest-files", workspacePath, prefix });
      if (response.type !== "file-suggestions") throw new Error("Cake received invalid file suggestions");
      return response.suggestions;
    },
    async listWorkspaceFiles(workspacePath) {
      const response = await bridge.request({ type: "list-workspace-files", workspacePath });
      if (response.type !== "workspace-files") throw new Error("Cake received an invalid workspace file list");
      return response.files;
    },
    async readWorkspaceFile(workspacePath, path) {
      const response = await bridge.request({ type: "read-workspace-file", workspacePath, path });
      if (response.type !== "workspace-file") throw new Error("Cake received invalid workspace file content");
      return response.content;
    },
    async compileInlineWidget(language, source, capability) {
      const response = await bridge.request({ type: "compile-inline-widget", language, source, capability });
      if (response.type !== "inline-widget-compiled") throw new Error("Cake could not compile the inline widget");
      return response.widget;
    },
    async repairInlineWidget(input) {
      const response = await bridge.request({ type: "repair-inline-widget", ...input });
      if (response.type !== "inline-widget-repaired") throw new Error("Cake could not repair the inline widget");
      return response.widget;
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
    async listSessions() {
      const response = await bridge.request({ type: "list-sessions" });
      if (response.type !== "sessions-listed") throw new Error("Cake received an invalid session index");
      return { sessions: response.sessions, reviewThreads: response.reviewThreads };
    },
    async loadSession(workspacePath, sessionId) {
      const response = await bridge.request({ type: "load-session", workspacePath, sessionId });
      if (response.type !== "session-loaded") throw new Error("Cake received invalid session content");
      return response.session;
    },
    openGlobalChat: (input) => accept(bridge, { type: "open-global-chat", requestId: input.operationId, tools: [...input.tools] }),
    promptGlobalChat: (input) => accept(bridge, { type: "prompt-global-chat", requestId: input.operationId, text: input.text }),
    abortGlobalChat: (operationId) => accept(bridge, { type: "abort-global-chat", requestId: operationId }),
    clearGlobalChat: (input) => accept(bridge, { type: "clear-global-chat", requestId: input.operationId, tools: [...input.tools] }),
    setGlobalChatModel: (input) => accept(bridge, { type: "set-global-chat-model", requestId: input.operationId, provider: input.provider, modelId: input.modelId }),
    setGlobalChatThinkingLevel: (input) => accept(bridge, { type: "set-global-chat-thinking", requestId: input.operationId, level: input.level }),
    async respondToGlobalChatControl(controlRequestId, result) {
      const response = await bridge.request({ type: "respond-global-chat-control", controlRequestId, result });
      if (response.type !== "accepted" || response.requestId !== controlRequestId) throw new Error("Cake received a mismatched global control response");
    },
    async listReviewThreads(workspacePath, sessionId) {
      const response = await bridge.request({ type: "list-review-threads", workspacePath, sessionId });
      if (response.type !== "review-threads-loaded") throw new Error("Cake received invalid review threads");
      return response.threads;
    },
    async createReviewThread(input) {
      const response = await bridge.request({ type: "create-review-thread", ...input });
      if (response.type !== "review-thread-saved") throw new Error("Cake could not save the review thread");
      return response.thread;
    },
    async replyReviewThread(input) {
      const response = await bridge.request({ type: "reply-review-thread", ...input });
      if (response.type !== "review-thread-saved") throw new Error("Cake could not save the review reply");
      return response.thread;
    },
    async resolveReviewThread(input) {
      const response = await bridge.request({ type: "resolve-review-thread", ...input });
      if (response.type !== "review-thread-saved") throw new Error("Cake could not update the review thread");
      return response.thread;
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
    async restartPi(path) { await bridge.request({ type: "restart-pi", path }); },
    inspectWorkspace: (input) => accept(bridge, { type: "inspect-workspace", requestId: input.operationId, path: input.path }),
    respondToWorkspaceTrust: (input) => accept(bridge, { type: "respond-workspace-trust", requestId: input.operationId, path: input.path, approved: input.approved }),
    openWorkspace: (input) => accept(bridge, { type: "open-workspace", requestId: input.operationId, path: input.path, newSession: input.newSession ?? false, sessionId: input.sessionId }),
    submit: (input) => accept(bridge, { type: "prompt", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, text: input.text, delivery: input.delivery, attachments: input.attachments }),
    submitReviewThreads: (input) => accept(bridge, { type: "submit-review-threads", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, threadIds: input.threadIds, commentCount: input.commentCount, instruction: input.instruction, model: input.model }),
    abort: (input) => accept(bridge, { type: "abort", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId }),
    setModel: (input) => accept(bridge, { type: "set-model", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, provider: input.provider, modelId: input.modelId }),
    setThinkingLevel: (input) => accept(bridge, { type: "set-thinking", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, level: input.level }),
    setPiSetting: (input) => accept(bridge, { type: "set-pi-setting", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, update: input.update }),
    reloadPi: (input) => accept(bridge, { type: "reload-pi", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId }),
    login: (input) => accept(bridge, { type: "login", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, provider: input.provider, authType: input.authType }),
    logout: (input) => accept(bridge, { type: "logout", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, provider: input.provider }),
    renameSession: (input) => accept(bridge, { type: "rename-session", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, name: input.name }),
    forkSession: (input) => accept(bridge, { type: "fork-session", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, entryId: input.entryId }),
    navigateSession: (input) => accept(bridge, { type: "navigate-session", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, entryId: input.entryId }),
    inspectChanges: (input) => accept(bridge, { type: "inspect-changes", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId }),
    getChangelog: (input) => accept(bridge, { type: "get-changelog", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId }),
    async respondToUi(input) {
      const response = await bridge.request({ type: "respond-ui", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, uiRequestId: input.uiRequestId, value: input.value, cancelled: input.cancelled });
      if (response.type !== "ui-response-accepted" || response.uiRequestId !== input.uiRequestId) throw new Error("Cake received a mismatched UI response");
    },
    async respondToArtifact(input) {
      const response = await bridge.request({ type: "respond-artifact", requestId: input.operationId, workspacePath: input.workspacePath, sessionId: input.sessionId, artifactRequestId: input.artifactRequestId, value: input.value, cancelled: input.cancelled });
      if (response.type !== "artifact-response-accepted" || response.artifactRequestId !== input.artifactRequestId) throw new Error("Cake received a mismatched artifact response");
    },
    async exportArtifacts(workspacePath, sessionId) {
      const response = await bridge.request({ type: "export-artifacts", workspacePath, sessionId });
      if (response.type !== "artifacts-exported") throw new Error("Cake could not export artifacts");
      return response.markdown;
    },
    subscribe(listener) {
      return bridge.subscribe((event) => {
        const mapped = toClientEvent(event);
        if (mapped) listener(mapped);
      });
    }
  };
}
