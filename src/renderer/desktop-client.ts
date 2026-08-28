import type { CakeDesktopBridge, DesktopEvent } from "../ipc/desktop-ipc";
import type {
  Attachment,
  ApplicationState,
  ChatConfiguration,
  FileSuggestion,
  GlobalSessionSummary,
  SessionSnapshot,
  SessionPreview,
  SessionSummary,
  PiSettingUpdate,
  ThinkingLevel,
  ModelPreset,
  UtilityModel,
  ExtensionUiEvent,
  UiPart,
  WindowViewState,
} from "../ipc/session-contract";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { ReviewAnchor, ReviewThread } from "../ipc/review-contract";
import type { SourceLocation } from "../ipc/source-location";
import type { EditorAnnotationSnapshot } from "../ipc/editor-annotation";
import type { WorktreeLandOutcome, WorktreeRecord, WorktreeStatus } from "../ipc/worktree-contract";
import type { CustomizationState, PluginDiagnostic, PluginStatus } from "../plugin/plugin-contract";
import type {
  CompiledInlineWidget,
  InlineWidgetCapability,
  InlineWidgetLanguage,
  RepairedInlineWidget,
} from "../ipc/inline-widget-contract";
import type { JsonObject, JsonValue } from "../ipc/json-contract";
import type { SubagentActivity } from "../ipc/subagent-activity-contract";
import type { ModelOption } from "../ipc/session-contract";
import type {
  PluginAgentOpenOptions,
  PluginAgentSnapshot,
  PluginCompletionRequest,
  PluginCompletionResult,
  SessionRef,
} from "../ipc/plugin-agent-contract";

export type PiState = "starting" | "ready" | "stopped" | "failed";

export type EmbeddedEditorStatus = "missing" | "downloading" | "starting" | "ready" | "failed";

export interface EmbeddedEditorStateSnapshot {
  status: EmbeddedEditorStatus;
  message?: string;
  customPath?: string;
}

export type DesktopClientEvent =
  | { type: "pi-state-changed"; state: PiState; workspacePath?: string }
  | { type: "workspace-inspected"; operationId: string; path: string; trustRequired: boolean }
  | { type: "session-snapshot-received"; operationId?: string; snapshot: SessionSnapshot }
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming-changed"; sessionId: string; streaming: boolean }
  | { type: "background-work-changed"; sessionId: string; active: boolean }
  | { type: "subagent-activity-received"; activity: SubagentActivity }
  | { type: "subagent-activity-removed"; parentSessionId: string; handleId: string }
  | { type: "global-chat-snapshot-received"; operationId?: string; snapshot: SessionSnapshot }
  | { type: "global-chat-part-updated"; sessionId: string; part: UiPart }
  | { type: "global-chat-part-removed"; sessionId: string; partId: string }
  | { type: "global-chat-streaming-changed"; sessionId: string; streaming: boolean }
  | { type: "global-chat-operation-completed"; operationId: string }
  | {
      type: "global-chat-operation-failed";
      operationId: string;
      message: string;
      details?: string;
    }
  | {
      type: "global-chat-control-requested";
      controlRequestId: string;
      invocation: { name: string; arguments: JsonValue };
    }
  | { type: "extension-ui-received"; sessionId: string; event: ExtensionUiEvent }
  | {
      type: "changelog-received";
      operationId: string;
      workspacePath: string;
      sessionId: string;
      markdown: string;
    }
  | { type: "artifact-updated"; record: ArtifactRecord }
  | {
      type: "artifact-requested";
      operationId: string;
      artifactRequestId: string;
      record: ArtifactRecord;
    }
  | {
      type: "review-threads-received";
      workspacePath: string;
      sessionId: string;
      threads: ReviewThread[];
    }
  | { type: "review-thread-updated"; thread: ReviewThread }
  | {
      type: "review-thread-streaming";
      workspacePath: string;
      sessionId: string;
      threadId: string;
      streaming: boolean;
    }
  | {
      type: "review-thread-part-updated";
      workspacePath: string;
      sessionId: string;
      threadId: string;
      part: UiPart;
    }
  | {
      type: "review-thread-usage-updated";
      workspacePath: string;
      sessionId: string;
      threadId: string;
      usage: NonNullable<SessionSnapshot["usage"]>;
    }
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
  | { type: "operation-failed"; operationId?: string; message: string; details?: string }
  | { type: "customization-state-changed"; state: CustomizationState }
  | { type: "application-state-changed"; state: ApplicationState }
  | { type: "plugin-agent-event"; pluginId: string; snapshot: PluginAgentSnapshot }
  | { type: "embedded-editor-state-received"; status: EmbeddedEditorStatus; message?: string }
  | {
      type: "embedded-editor-location-opened";
      workspacePath: string;
      location: SourceLocation;
    }
  | {
      type: "embedded-editor-activity";
      workspacePath: string;
      path: string;
      documentVersion: number;
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
      selectedText: string;
      contextBefore: string;
      contextAfter: string;
    }
  | { type: "embedded-editor-back-to-agent"; workspacePath: string }
  | {
      type: "embedded-editor-annotation-opened";
      workspacePath: string;
      sessionId: string;
      threadId: string;
    }
  | { type: "embedded-editor-toggle-chat"; workspacePath: string }
  | { type: "embedded-editor-context-cleared"; workspacePath: string };

export interface DesktopClient {
  chooseProject(): Promise<string | undefined>;
  showTranscriptSelectionContextMenu(input: {
    canChat: boolean;
    canAnnotate: boolean;
  }): Promise<"chat-about-selection" | "add-annotation" | undefined>;
  showSessionContextMenu(input: {
    sessionId: string;
    x: number;
    y: number;
  }): Promise<"rename" | undefined>;
  listModels(): Promise<ModelOption[]>;
  getHomeDirectory(): Promise<string>;
  getCustomizationState(): Promise<CustomizationState>;
  getPluginAuthoringReference(): Promise<string>;
  listPluginFiles(): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  createPlugin(input: {
    pluginId: string;
    name: string;
    renderer: boolean;
    backend: boolean;
    scene: boolean;
    expectedWorkingRevision: string;
  }): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  readPluginFile(pluginId: string, path: string): Promise<string>;
  writePluginFile(
    pluginId: string,
    path: string,
    content: string,
    expectedWorkingRevision: string,
  ): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  validateCustomization(
    expectedBaseRevision?: string,
    request?: string,
    expectedSourceRevision?: string,
  ): Promise<{
    revision: string;
    sourceRevision: string;
    diagnostics: PluginDiagnostic[];
    valid: boolean;
  }>;
  activateCustomization(
    revision: string,
    expectedSourceRevision: string,
    request?: string,
  ): Promise<{ revision: string; activating: true }>;
  rollbackCustomization(): Promise<CustomizationState>;
  useFactoryCustomization(): Promise<CustomizationState>;
  listPlugins(): Promise<PluginStatus[]>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginStatus[]>;
  setActiveScene(pluginId?: string): Promise<PluginStatus[]>;
  deletePlugin(pluginId: string): Promise<PluginStatus[]>;
  openPluginAgent(
    pluginId: string,
    options: PluginAgentOpenOptions,
    implicitSession?: SessionRef,
  ): Promise<PluginAgentSnapshot>;
  promptPluginAgent(
    pluginId: string,
    handleId: string,
    delivery: "prompt" | "steer" | "follow-up",
    text: string,
  ): Promise<PluginAgentSnapshot>;
  abortPluginAgent(pluginId: string, handleId: string): Promise<PluginAgentSnapshot>;
  detachPluginAgent(pluginId: string, handleId: string): Promise<void>;
  runPluginCompletion(
    pluginId: string,
    requestId: string,
    request: PluginCompletionRequest,
    implicitSession?: SessionRef,
  ): Promise<PluginCompletionResult>;
  cancelPluginCompletion(pluginId: string, requestId: string): Promise<void>;
  chooseAttachments(): Promise<Attachment[]>;
  suggestFiles(workspacePath: string, prefix: string): Promise<FileSuggestion[]>;
  readWorkspaceFile(workspacePath: string, path: string): Promise<string>;
  compileInlineWidget(
    language: InlineWidgetLanguage,
    source: string,
    capability: InlineWidgetCapability,
  ): Promise<CompiledInlineWidget>;
  repairInlineWidget(input: {
    sessionId: string;
    language: InlineWidgetLanguage;
    capability: InlineWidgetCapability;
    source: string;
    context: string;
    diagnostic?: string;
    model?: { provider: string; id: string };
  }): Promise<RepairedInlineWidget>;
  loadWindowState(): Promise<WindowViewState>;
  saveWindowState(state: WindowViewState): Promise<void>;
  loadApplicationState(): Promise<ApplicationState>;
  setVscodeServerPath(path: string | undefined): Promise<ApplicationState>;
  getEmbeddedEditorState(): Promise<EmbeddedEditorStateSnapshot>;
  installEmbeddedEditor(): Promise<void>;
  openEmbeddedEditor(workspacePath: string): Promise<void>;
  updateEmbeddedEditorBounds(input: {
    visible: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void>;
  revealInEmbeddedEditor(workspacePath: string, location: SourceLocation): Promise<void>;
  openEmbeddedEditorSourceControl(workspacePath: string): Promise<void>;
  updateEmbeddedEditorAnnotations(
    workspacePath: string,
    snapshot: EditorAnnotationSnapshot,
  ): Promise<void>;
  setUtilityModel(model: UtilityModel | undefined): Promise<ApplicationState>;
  setModelPresets(
    presets: readonly ModelPreset[],
    defaultPresetId?: string,
  ): Promise<ApplicationState>;
  listSessions(): Promise<{ sessions: GlobalSessionSummary[]; reviewThreads: ReviewThread[] }>;
  listCakeChatSessions(): Promise<SessionSummary[]>;
  loadSession(sessionId: string): Promise<SessionPreview | undefined>;
  openGlobalChat(input: {
    operationId: string;
    tools: ReadonlyArray<{
      command: string;
      topic: string;
      summary: string;
      guidance?: readonly string[];
      parameters: JsonObject;
      examples?: readonly { input?: JsonObject; description?: string }[];
      result?: string;
      limitations?: readonly string[];
    }>;
    sessionId?: string;
  }): Promise<void>;
  promptGlobalChat(input: {
    operationId: string;
    sessionId: string;
    text: string;
    attachments: Attachment[];
    newSession?: {
      tools: ReadonlyArray<{
        command: string;
        topic: string;
        summary: string;
        guidance?: readonly string[];
        parameters: JsonObject;
        examples?: readonly { input?: JsonObject; description?: string }[];
        result?: string;
        limitations?: readonly string[];
      }>;
      configuration?: ChatConfiguration;
      name?: string;
    };
  }): Promise<void>;
  abortGlobalChat(input: { operationId: string; sessionId: string }): Promise<void>;
  compactGlobalChat(input: {
    operationId: string;
    sessionId: string;
    instructions?: string;
  }): Promise<void>;
  setGlobalChatModel(input: {
    operationId: string;
    sessionId: string;
    provider: string;
    modelId: string;
  }): Promise<void>;
  setGlobalChatThinkingLevel(input: {
    operationId: string;
    sessionId: string;
    level: ThinkingLevel;
  }): Promise<void>;
  setGlobalChatConfiguration(input: {
    operationId: string;
    sessionId: string;
    configuration: ChatConfiguration;
  }): Promise<void>;
  setGlobalChatFastMode(input: {
    operationId: string;
    sessionId: string;
    enabled: boolean;
  }): Promise<void>;
  renameGlobalChat(input: { operationId: string; sessionId: string; name: string }): Promise<void>;
  handoffGlobalChat(input: {
    operationId: string;
    sessionId: string;
    entryId: string;
    prompt?: string;
    resolveSource?: boolean;
  }): Promise<void>;
  respondToGlobalChatControl(controlRequestId: string, result: JsonValue): Promise<void>;
  listReviewThreads(sessionId: string): Promise<ReviewThread[]>;
  createReviewThread(input: {
    sessionId: string;
    anchor: ReviewAnchor;
    body: string;
  }): Promise<ReviewThread>;
  replyReviewThread(input: {
    sessionId: string;
    threadId: string;
    body: string;
  }): Promise<ReviewThread>;
  resolveReviewThread(input: {
    sessionId: string;
    threadId: string;
    resolved: boolean;
  }): Promise<ReviewThread>;
  submitReviewThread(input: {
    operationId: string;
    sessionId: string;
    threadId: string;
    model?: { provider: string; id: string };
    thinkingLevel?: ThinkingLevel;
  }): Promise<void>;
  registerProject(path: string, name: string): Promise<ApplicationState>;
  renameProject(path: string, name: string): Promise<ApplicationState>;
  removeProject(path: string): Promise<ApplicationState>;
  resolveSession(sessionId: string, resolved: boolean): Promise<ApplicationState>;
  resolveSessions(sessionIds: readonly string[], resolved: boolean): Promise<ApplicationState>;
  resolveCakeChatSession(sessionId: string, resolved: boolean): Promise<ApplicationState>;
  restartPi(path: string): Promise<void>;
  inspectWorkspace(input: { operationId: string; path: string }): Promise<void>;
  respondToWorkspaceTrust(input: {
    operationId: string;
    path: string;
    approved: boolean;
  }): Promise<void>;
  openWorkspace(input: {
    operationId: string;
    path: string;
    newSession?: boolean;
    sessionId?: string;
    configuration?: ChatConfiguration;
  }): Promise<void>;
  createWorktree(input: { operationId: string; path: string }): Promise<WorktreeRecord>;
  getWorktreeStatus(input: { workspacePath: string }): Promise<WorktreeStatus | undefined>;
  landWorktree(input: {
    operationId: string;
    workspacePath: string;
    message?: string;
    autoResolve: boolean;
  }): Promise<WorktreeLandOutcome>;
  discardWorktree(input: {
    operationId: string;
    workspacePath: string;
    keepBranch: boolean;
  }): Promise<void>;
  forkWorktreeSession(input: {
    operationId: string;
    sessionId: string;
    entryId: string;
    workspacePath: string;
  }): Promise<{ sessionId: string; workspacePath: string }>;
  steerSubagent(input: { parentSessionId: string; handleId: string; text: string }): Promise<void>;
  abortSubagent(input: { parentSessionId: string; handleId: string }): Promise<void>;
  submit(input: {
    operationId: string;
    sessionId: string;
    text: string;
    delivery: "prompt" | "steer" | "follow-up";
    attachments: Attachment[];
    newSession?: { path: string; configuration?: ChatConfiguration };
  }): Promise<void>;
  abort(input: { operationId: string; sessionId: string }): Promise<void>;
  compactSession(input: {
    operationId: string;
    sessionId: string;
    instructions?: string;
  }): Promise<void>;
  setModel(input: {
    operationId: string;
    sessionId: string;
    provider: string;
    modelId: string;
  }): Promise<void>;
  setThinkingLevel(input: {
    operationId: string;
    sessionId: string;
    level: ThinkingLevel;
  }): Promise<void>;
  setChatConfiguration(input: {
    operationId: string;
    sessionId: string;
    configuration: ChatConfiguration;
  }): Promise<void>;
  setFastMode(input: { operationId: string; sessionId: string; enabled: boolean }): Promise<void>;
  setPiSetting(input: {
    operationId: string;
    sessionId: string;
    update: PiSettingUpdate;
  }): Promise<void>;
  reloadPi(input: { operationId: string; sessionId: string }): Promise<void>;
  refreshModels(input: { operationId: string; sessionId: string }): Promise<void>;
  login(input: {
    operationId: string;
    sessionId: string;
    provider: string;
    authType: "api_key" | "oauth";
  }): Promise<void>;
  logout(input: { operationId: string; sessionId: string; provider: string }): Promise<void>;
  renameSession(input: { operationId: string; sessionId: string; name: string }): Promise<void>;
  forkSession(input: { operationId: string; sessionId: string; entryId: string }): Promise<void>;
  handoffSession(input: {
    operationId: string;
    sessionId: string;
    entryId: string;
    prompt?: string;
    resolveSource?: boolean;
  }): Promise<void>;
  navigateSession(input: {
    operationId: string;
    sessionId: string;
    entryId: string;
  }): Promise<void>;
  getChangelog(input: { operationId: string; sessionId: string }): Promise<void>;
  respondToUi(input: {
    operationId: string;
    sessionId: string;
    uiRequestId: string;
    value?: string;
    cancelled: boolean;
  }): Promise<void>;
  respondToArtifact(input: {
    operationId: string;
    sessionId: string;
    artifactRequestId: string;
    value?: JsonValue;
    cancelled: boolean;
  }): Promise<void>;
  exportArtifacts(sessionId: string): Promise<string>;
  subscribe(listener: (event: DesktopClientEvent) => void): () => void;
}

function toClientEvent(event: DesktopEvent): DesktopClientEvent | undefined {
  if (event.type === "pi-state")
    return { type: "pi-state-changed", state: event.state, workspacePath: event.workspacePath };
  if (event.type === "workspace-inspected")
    return {
      type: "workspace-inspected",
      operationId: event.requestId,
      path: event.path,
      trustRequired: event.trustRequired,
    };
  if (event.type === "session-snapshot")
    return {
      type: "session-snapshot-received",
      operationId: event.requestId,
      snapshot: event.snapshot,
    };
  if (event.type === "part-updated" || event.type === "part-removed") return event;
  if (event.type === "session-streaming")
    return { type: "streaming-changed", sessionId: event.sessionId, streaming: event.streaming };
  if (event.type === "session-background-work")
    return { type: "background-work-changed", sessionId: event.sessionId, active: event.active };
  if (event.type === "subagent-activity")
    return { type: "subagent-activity-received", activity: event.activity };
  if (event.type === "subagent-activity-removed") return event;
  if (event.type === "global-chat-snapshot")
    return {
      type: "global-chat-snapshot-received",
      operationId: event.requestId,
      snapshot: event.snapshot,
    };
  if (event.type === "global-chat-part-updated" || event.type === "global-chat-part-removed")
    return event;
  if (event.type === "global-chat-streaming")
    return {
      type: "global-chat-streaming-changed",
      sessionId: event.sessionId,
      streaming: event.streaming,
    };
  if (event.type === "global-chat-operation-completed")
    return { type: event.type, operationId: event.requestId };
  if (event.type === "global-chat-operation-failed")
    return {
      type: event.type,
      operationId: event.requestId,
      message: event.message,
      details: event.details,
    };
  if (event.type === "global-chat-control-request")
    return {
      type: "global-chat-control-requested",
      controlRequestId: event.controlRequestId,
      invocation: event.invocation,
    };
  if (event.type === "extension-ui")
    return { type: "extension-ui-received", sessionId: event.sessionId, event: event.event };
  if (event.type === "plugin-agent-event") return event;
  if (event.type === "artifact-updated") return event;
  if (event.type === "artifact-requested")
    return {
      type: "artifact-requested",
      operationId: event.requestId,
      artifactRequestId: event.artifactRequestId,
      record: event.record,
    };
  if (event.type === "review-threads-snapshot")
    return {
      type: "review-threads-received",
      workspacePath: event.workspacePath,
      sessionId: event.sessionId,
      threads: event.threads,
    };
  if (
    event.type === "review-thread-updated" ||
    event.type === "review-thread-streaming" ||
    event.type === "review-thread-part-updated" ||
    event.type === "review-thread-usage-updated"
  )
    return event;
  if (event.type === "changelog-snapshot")
    return {
      type: "changelog-received",
      operationId: event.requestId,
      workspacePath: event.workspacePath,
      sessionId: event.sessionId,
      markdown: event.markdown,
    };
  if (event.type === "ui-request")
    return {
      type: "ui-requested",
      operationId: event.requestId,
      uiRequestId: event.uiRequestId,
      kind: event.kind,
      title: event.title,
      message: event.message,
      placeholder: event.placeholder,
      initialValue: event.initialValue,
      multiline: event.multiline,
      options: event.options,
    };
  if (event.type === "complete")
    return { type: "operation-completed", operationId: event.requestId };
  if (event.type === "fatal")
    return {
      type: "operation-failed",
      operationId: event.requestId,
      message: event.message,
      details: event.details,
    };
  if (event.type === "customization-state-changed") return event;
  if (event.type === "application-state-changed") return event;
  if (event.type === "embedded-editor-state")
    return {
      type: "embedded-editor-state-received",
      status: event.status,
      message: event.message,
    };
  if (
    event.type === "embedded-editor-activity" ||
    event.type === "embedded-editor-annotation-opened" ||
    event.type === "embedded-editor-back-to-agent" ||
    event.type === "embedded-editor-toggle-chat" ||
    event.type === "embedded-editor-context-cleared" ||
    event.type === "embedded-editor-location-opened"
  )
    return event;
  return undefined;
}

async function accept(
  bridge: CakeDesktopBridge,
  request: Parameters<CakeDesktopBridge["request"]>[0] & { requestId: string },
) {
  const response = await bridge.request(request);
  if (response.type !== "accepted" || response.requestId !== request.requestId)
    throw new Error("Cake received a mismatched operation response");
}

export function createDesktopClient(bridge: CakeDesktopBridge): DesktopClient {
  return {
    async chooseProject() {
      const response = await bridge.request({ type: "choose-project" });
      if (response.type !== "project-chosen")
        throw new Error("Cake received an invalid project response");
      return response.path;
    },
    async showTranscriptSelectionContextMenu(input) {
      const response = await bridge.request({
        type: "show-transcript-selection-context-menu",
        ...input,
      });
      if (response.type !== "transcript-selection-context-menu-closed")
        throw new Error("Cake received an invalid transcript selection context menu response");
      return response.action;
    },
    async showSessionContextMenu(input) {
      const response = await bridge.request({ type: "show-session-context-menu", ...input });
      if (response.type !== "session-context-menu-closed")
        throw new Error("Cake received an invalid session context menu response");
      return response.action;
    },
    async listModels() {
      const requestId = crypto.randomUUID();
      const response = await bridge.request({ type: "list-models", requestId });
      if (response.type !== "models-listed" || response.requestId !== requestId)
        throw new Error("Cake received an invalid model catalog response");
      return response.models;
    },
    async getHomeDirectory() {
      const response = await bridge.request({ type: "get-home-directory" });
      if (response.type !== "home-directory")
        throw new Error("Cake could not resolve the home directory");
      return response.path;
    },
    async getCustomizationState() {
      const response = await bridge.request({ type: "get-customization-state" });
      if (response.type !== "customization-state")
        throw new Error("Cake received invalid customization state");
      return response.state;
    },
    async getPluginAuthoringReference() {
      const response = await bridge.request({ type: "get-plugin-authoring-reference" });
      if (response.type !== "plugin-authoring-reference")
        throw new Error("Cake returned an invalid plugin authoring reference");
      return response.reference;
    },
    async listPluginFiles() {
      const response = await bridge.request({ type: "list-plugin-files" });
      if (response.type !== "plugin-files") throw new Error("Cake returned invalid plugin files");
      return response;
    },
    async createPlugin(input) {
      const response = await bridge.request({ type: "create-plugin", ...input });
      if (response.type !== "plugin-files") throw new Error("Cake could not create the plugin");
      return response;
    },
    async readPluginFile(pluginId, path) {
      const response = await bridge.request({ type: "read-plugin-file", pluginId, path });
      if (response.type !== "plugin-file") throw new Error("Cake returned invalid plugin source");
      return response.content;
    },
    async writePluginFile(pluginId, path, content, expectedWorkingRevision) {
      const response = await bridge.request({
        type: "write-plugin-file",
        pluginId,
        path,
        content,
        expectedWorkingRevision,
      });
      if (response.type !== "plugin-files") throw new Error("Cake returned invalid plugin files");
      return response;
    },
    async validateCustomization(expectedBaseRevision, request, expectedSourceRevision) {
      const response = await bridge.request({
        type: "validate-customization",
        expectedBaseRevision,
        expectedSourceRevision,
        request,
      });
      if (response.type !== "customization-validation")
        throw new Error("Cake received invalid customization validation results");
      return response;
    },
    async activateCustomization(revision, expectedSourceRevision, request) {
      const response = await bridge.request({
        type: "activate-customization",
        revision,
        expectedSourceRevision,
        request,
      });
      if (response.type !== "customization-activation")
        throw new Error("Cake could not activate the customization");
      return response;
    },
    async rollbackCustomization() {
      const response = await bridge.request({ type: "rollback-customization" });
      if (response.type !== "customization-state")
        throw new Error("Cake could not roll back customization");
      return response.state;
    },
    async useFactoryCustomization() {
      const response = await bridge.request({ type: "use-factory-customization" });
      if (response.type !== "customization-state")
        throw new Error("Cake could not switch to the default interface");
      return response.state;
    },
    async listPlugins() {
      const response = await bridge.request({ type: "list-plugins" });
      if (response.type !== "plugins-listed")
        throw new Error("Cake received an invalid plugin list");
      return response.plugins;
    },
    async setPluginEnabled(pluginId, enabled) {
      const response = await bridge.request({ type: "set-plugin-enabled", pluginId, enabled });
      if (response.type !== "plugins-listed") throw new Error("Cake could not update the plugin");
      return response.plugins;
    },
    async setActiveScene(pluginId) {
      const response = await bridge.request({ type: "set-active-scene", pluginId });
      if (response.type !== "plugins-listed") throw new Error("Cake could not select the scene");
      return response.plugins;
    },
    async deletePlugin(pluginId) {
      const response = await bridge.request({ type: "delete-plugin", pluginId });
      if (response.type !== "plugins-listed") throw new Error("Cake could not delete the plugin");
      return response.plugins;
    },
    async openPluginAgent(pluginId, options, implicitSession) {
      const response = await bridge.request({
        type: "open-plugin-agent",
        pluginId,
        options,
        implicitSession,
      });
      if (response.type !== "plugin-agent-snapshot")
        throw new Error("Cake could not open the plugin agent");
      return response.snapshot;
    },
    async promptPluginAgent(pluginId, handleId, delivery, text) {
      const response = await bridge.request({
        type: "prompt-plugin-agent",
        pluginId,
        handleId,
        delivery,
        text,
      });
      if (response.type !== "plugin-agent-snapshot")
        throw new Error("Cake could not prompt the plugin agent");
      return response.snapshot;
    },
    async abortPluginAgent(pluginId, handleId) {
      const response = await bridge.request({ type: "abort-plugin-agent", pluginId, handleId });
      if (response.type !== "plugin-agent-snapshot")
        throw new Error("Cake could not abort the plugin agent");
      return response.snapshot;
    },
    async detachPluginAgent(pluginId, handleId) {
      const response = await bridge.request({ type: "detach-plugin-agent", pluginId, handleId });
      if (response.type !== "plugin-agent-detached" || response.handleId !== handleId)
        throw new Error("Cake could not detach the plugin agent");
    },
    async runPluginCompletion(pluginId, requestId, request, implicitSession) {
      const response = await bridge.request({
        type: "run-plugin-completion",
        pluginId,
        requestId,
        request,
        implicitSession,
      });
      if (response.type !== "plugin-completion-result" || response.requestId !== requestId)
        throw new Error("Cake received a mismatched plugin completion");
      return response.result;
    },
    async cancelPluginCompletion(pluginId, requestId) {
      await bridge.request({ type: "cancel-plugin-completion", pluginId, requestId });
    },
    async chooseAttachments() {
      const response = await bridge.request({ type: "choose-attachments" });
      if (response.type !== "attachments-chosen")
        throw new Error("Cake received an invalid attachment response");
      return response.attachments;
    },
    async suggestFiles(workspacePath, prefix) {
      const response = await bridge.request({ type: "suggest-files", workspacePath, prefix });
      if (response.type !== "file-suggestions")
        throw new Error("Cake received invalid file suggestions");
      return response.suggestions;
    },
    async readWorkspaceFile(workspacePath, path) {
      const response = await bridge.request({ type: "read-workspace-file", workspacePath, path });
      if (response.type !== "workspace-file")
        throw new Error("Cake received invalid workspace file content");
      return response.content;
    },
    async compileInlineWidget(language, source, capability) {
      const response = await bridge.request({
        type: "compile-inline-widget",
        language,
        source,
        capability,
      });
      if (response.type !== "inline-widget-compiled")
        throw new Error("Cake could not compile the inline widget");
      return response.widget;
    },
    async repairInlineWidget(input) {
      const response = await bridge.request({ type: "repair-inline-widget", ...input });
      if (response.type !== "inline-widget-repaired")
        throw new Error("Cake could not repair the inline widget");
      return response.widget;
    },
    async loadWindowState() {
      const response = await bridge.request({ type: "load-window-state" });
      if (response.type !== "window-state-loaded")
        throw new Error("Cake received invalid window state");
      return response.state;
    },
    async saveWindowState(state) {
      const response = await bridge.request({ type: "save-window-state", state });
      if (response.type !== "window-state-saved")
        throw new Error("Cake could not persist window state");
    },
    async loadApplicationState() {
      const response = await bridge.request({ type: "load-application-state" });
      if (response.type !== "application-state-loaded")
        throw new Error("Cake received invalid application state");
      return response.state;
    },
    async setVscodeServerPath(path) {
      const response = await bridge.request({ type: "set-vscode-server-path", path });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not update the embedded editor path");
      return response.state;
    },
    async getEmbeddedEditorState() {
      const response = await bridge.request({ type: "get-embedded-editor-state" });
      if (response.type !== "embedded-editor-state-loaded")
        throw new Error("Cake received an invalid embedded editor state");
      return {
        status: response.status,
        message: response.message,
        customPath: response.customPath,
      };
    },
    async installEmbeddedEditor() {
      const requestId = crypto.randomUUID();
      await accept(bridge, { type: "install-embedded-editor", requestId });
    },
    async openEmbeddedEditor(workspacePath) {
      const requestId = crypto.randomUUID();
      await accept(bridge, { type: "open-embedded-editor", requestId, workspacePath });
    },
    async updateEmbeddedEditorBounds(input) {
      const requestId = crypto.randomUUID();
      await accept(bridge, { type: "update-embedded-editor-bounds", requestId, ...input });
    },
    async revealInEmbeddedEditor(workspacePath, location) {
      const requestId = crypto.randomUUID();
      await accept(bridge, {
        type: "reveal-in-embedded-editor",
        requestId,
        workspacePath,
        location,
      });
    },
    async openEmbeddedEditorSourceControl(workspacePath) {
      await accept(bridge, {
        type: "open-embedded-editor-source-control",
        requestId: crypto.randomUUID(),
        workspacePath,
      });
    },
    async updateEmbeddedEditorAnnotations(workspacePath, snapshot) {
      const requestId = crypto.randomUUID();
      await accept(bridge, {
        type: "update-embedded-editor-annotations",
        requestId,
        workspacePath,
        snapshot,
      });
    },
    async setUtilityModel(model) {
      const response = await bridge.request({ type: "set-utility-model", model });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not update the utility model");
      return response.state;
    },
    async setModelPresets(presets, defaultPresetId) {
      const response = await bridge.request({
        type: "set-model-presets",
        presets: [...presets],
        defaultPresetId,
      });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not update model presets");
      return response.state;
    },
    async listSessions() {
      const response = await bridge.request({ type: "list-sessions" });
      if (response.type !== "sessions-listed")
        throw new Error("Cake received an invalid session index");
      return { sessions: response.sessions, reviewThreads: response.reviewThreads };
    },
    async listCakeChatSessions() {
      const response = await bridge.request({ type: "list-cake-chat-sessions" });
      if (response.type !== "cake-chat-sessions-listed")
        throw new Error("Cake received an invalid Cake Chat session index");
      return response.sessions;
    },
    async loadSession(sessionId) {
      const response = await bridge.request({ type: "load-session", sessionId });
      if (response.type !== "session-loaded")
        throw new Error("Cake received invalid session content");
      return response.session;
    },
    openGlobalChat: (input) =>
      accept(bridge, {
        type: "open-global-chat",
        requestId: input.operationId,
        tools: input.tools.map((tool) => ({
          ...tool,
          guidance: tool.guidance ? [...tool.guidance] : undefined,
          examples: tool.examples?.map((example) => ({ ...example })),
          limitations: tool.limitations ? [...tool.limitations] : undefined,
        })),
        sessionId: input.sessionId,
      }),
    promptGlobalChat: (input) =>
      accept(bridge, {
        type: "prompt-global-chat",
        requestId: input.operationId,
        sessionId: input.sessionId,
        text: input.text,
        attachments: input.attachments,
        newSession: input.newSession
          ? {
              ...input.newSession,
              tools: input.newSession.tools.map((tool) => ({
                ...tool,
                guidance: tool.guidance ? [...tool.guidance] : undefined,
                examples: tool.examples?.map((example) => ({ ...example })),
                limitations: tool.limitations ? [...tool.limitations] : undefined,
              })),
            }
          : undefined,
      }),
    abortGlobalChat: (input) =>
      accept(bridge, {
        type: "abort-global-chat",
        requestId: input.operationId,
        sessionId: input.sessionId,
      }),
    compactGlobalChat: (input) =>
      accept(bridge, {
        type: "compact-global-chat",
        requestId: input.operationId,
        sessionId: input.sessionId,
        instructions: input.instructions,
      }),
    setGlobalChatModel: (input) =>
      accept(bridge, {
        type: "set-global-chat-model",
        requestId: input.operationId,
        sessionId: input.sessionId,
        provider: input.provider,
        modelId: input.modelId,
      }),
    setGlobalChatThinkingLevel: (input) =>
      accept(bridge, {
        type: "set-global-chat-thinking",
        requestId: input.operationId,
        sessionId: input.sessionId,
        level: input.level,
      }),
    setGlobalChatConfiguration: (input) =>
      accept(bridge, {
        type: "set-global-chat-configuration",
        requestId: input.operationId,
        sessionId: input.sessionId,
        configuration: input.configuration,
      }),
    setGlobalChatFastMode: (input) =>
      accept(bridge, {
        type: "set-global-chat-fast-mode",
        requestId: input.operationId,
        sessionId: input.sessionId,
        enabled: input.enabled,
      }),
    renameGlobalChat: (input) =>
      accept(bridge, {
        type: "rename-global-chat",
        requestId: input.operationId,
        sessionId: input.sessionId,
        name: input.name,
      }),
    handoffGlobalChat: (input) =>
      accept(bridge, {
        type: "handoff-global-chat",
        requestId: input.operationId,
        sessionId: input.sessionId,
        entryId: input.entryId,
        prompt: input.prompt,
        resolveSource: input.resolveSource ?? false,
      }),
    async respondToGlobalChatControl(controlRequestId, result) {
      const response = await bridge.request({
        type: "respond-global-chat-control",
        controlRequestId,
        result,
      });
      if (response.type !== "accepted" || response.requestId !== controlRequestId)
        throw new Error("Cake received a mismatched global control response");
    },
    async listReviewThreads(sessionId) {
      const response = await bridge.request({ type: "list-review-threads", sessionId });
      if (response.type !== "review-threads-loaded")
        throw new Error("Cake received invalid review threads");
      return response.threads;
    },
    async createReviewThread(input) {
      const response = await bridge.request({ type: "create-review-thread", ...input });
      if (response.type !== "review-thread-saved")
        throw new Error("Cake could not save the review thread");
      return response.thread;
    },
    async replyReviewThread(input) {
      const response = await bridge.request({ type: "reply-review-thread", ...input });
      if (response.type !== "review-thread-saved")
        throw new Error("Cake could not save the review reply");
      return response.thread;
    },
    async resolveReviewThread(input) {
      const response = await bridge.request({ type: "resolve-review-thread", ...input });
      if (response.type !== "review-thread-saved")
        throw new Error("Cake could not update the review thread");
      return response.thread;
    },
    async registerProject(path, name) {
      const response = await bridge.request({ type: "register-project", path, name });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not register the project");
      return response.state;
    },
    async renameProject(path, name) {
      const response = await bridge.request({ type: "rename-project", path, name });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not rename the project");
      return response.state;
    },
    async removeProject(path) {
      const response = await bridge.request({ type: "remove-project", path });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not remove the project");
      return response.state;
    },
    async resolveSession(sessionId, resolved) {
      const response = await bridge.request({ type: "resolve-session", sessionId, resolved });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not resolve the session");
      return response.state;
    },
    async resolveSessions(sessionIds, resolved) {
      const response = await bridge.request({
        type: "resolve-sessions",
        sessionIds: [...sessionIds],
        resolved,
      });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not resolve the sessions");
      return response.state;
    },
    async resolveCakeChatSession(sessionId, resolved) {
      const response = await bridge.request({
        type: "resolve-cake-chat-session",
        sessionId,
        resolved,
      });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not resolve the Cake Chat session");
      return response.state;
    },
    async restartPi(path) {
      await bridge.request({ type: "restart-pi", path });
    },
    inspectWorkspace: (input) =>
      accept(bridge, { type: "inspect-workspace", requestId: input.operationId, path: input.path }),
    respondToWorkspaceTrust: (input) =>
      accept(bridge, {
        type: "respond-workspace-trust",
        requestId: input.operationId,
        path: input.path,
        approved: input.approved,
      }),
    openWorkspace: (input) =>
      accept(bridge, {
        type: "open-workspace",
        requestId: input.operationId,
        path: input.path,
        newSession: input.newSession ?? false,
        sessionId: input.sessionId,
        configuration: input.configuration,
      }),
    async createWorktree(input) {
      const response = await bridge.request({
        type: "create-worktree",
        requestId: input.operationId,
        path: input.path,
      });
      if (response.type !== "worktree-created")
        throw new Error("Cake could not create the worktree");
      return response.record;
    },
    async getWorktreeStatus(input) {
      const response = await bridge.request({ type: "get-worktree-status", ...input });
      if (response.type !== "worktree-status-loaded")
        throw new Error("Cake returned an invalid worktree status");
      return response.status;
    },
    async landWorktree(input) {
      const response = await bridge.request({
        type: "land-worktree",
        requestId: input.operationId,
        workspacePath: input.workspacePath,
        message: input.message,
        autoResolve: input.autoResolve,
      });
      if (response.type !== "worktree-landed")
        throw new Error("Cake received an unexpected worktree landing response");
      return response.result;
    },
    discardWorktree: (input) =>
      accept(bridge, {
        type: "discard-worktree",
        requestId: input.operationId,
        workspacePath: input.workspacePath,
        keepBranch: input.keepBranch,
      }),
    async forkWorktreeSession(input) {
      const response = await bridge.request({
        type: "fork-worktree-session",
        requestId: input.operationId,
        sessionId: input.sessionId,
        entryId: input.entryId,
        workspacePath: input.workspacePath,
      });
      if (response.type !== "worktree-session-forked")
        throw new Error("Cake could not fork the session into a new worktree");
      return { sessionId: response.sessionId, workspacePath: response.workspacePath };
    },
    steerSubagent: (input) =>
      accept(bridge, {
        type: "steer-subagent",
        requestId: crypto.randomUUID(),
        ...input,
      }),
    abortSubagent: (input) =>
      accept(bridge, {
        type: "abort-subagent",
        requestId: crypto.randomUUID(),
        ...input,
      }),
    submit: (input) =>
      accept(bridge, {
        type: "prompt",
        requestId: input.operationId,
        sessionId: input.sessionId,
        text: input.text,
        delivery: input.delivery,
        attachments: input.attachments,
        newSession: input.newSession,
      }),
    submitReviewThread: (input) =>
      accept(bridge, {
        type: "submit-review-thread",
        requestId: input.operationId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      }),
    abort: (input) =>
      accept(bridge, { type: "abort", requestId: input.operationId, sessionId: input.sessionId }),
    compactSession: (input) =>
      accept(bridge, {
        type: "compact-session",
        requestId: input.operationId,
        sessionId: input.sessionId,
        instructions: input.instructions,
      }),
    setModel: (input) =>
      accept(bridge, {
        type: "set-model",
        requestId: input.operationId,
        sessionId: input.sessionId,
        provider: input.provider,
        modelId: input.modelId,
      }),
    setThinkingLevel: (input) =>
      accept(bridge, {
        type: "set-thinking",
        requestId: input.operationId,
        sessionId: input.sessionId,
        level: input.level,
      }),
    setChatConfiguration: (input) =>
      accept(bridge, {
        type: "set-chat-configuration",
        requestId: input.operationId,
        sessionId: input.sessionId,
        configuration: input.configuration,
      }),
    setFastMode: (input) =>
      accept(bridge, {
        type: "set-fast-mode",
        requestId: input.operationId,
        sessionId: input.sessionId,
        enabled: input.enabled,
      }),
    setPiSetting: (input) =>
      accept(bridge, {
        type: "set-pi-setting",
        requestId: input.operationId,
        sessionId: input.sessionId,
        update: input.update,
      }),
    reloadPi: (input) =>
      accept(bridge, {
        type: "reload-pi",
        requestId: input.operationId,
        sessionId: input.sessionId,
      }),
    refreshModels: (input) =>
      accept(bridge, {
        type: "refresh-models",
        requestId: input.operationId,
        sessionId: input.sessionId,
      }),
    login: (input) =>
      accept(bridge, {
        type: "login",
        requestId: input.operationId,
        sessionId: input.sessionId,
        provider: input.provider,
        authType: input.authType,
      }),
    logout: (input) =>
      accept(bridge, {
        type: "logout",
        requestId: input.operationId,
        sessionId: input.sessionId,
        provider: input.provider,
      }),
    renameSession: (input) =>
      accept(bridge, {
        type: "rename-session",
        requestId: input.operationId,
        sessionId: input.sessionId,
        name: input.name,
      }),
    forkSession: (input) =>
      accept(bridge, {
        type: "fork-session",
        requestId: input.operationId,
        sessionId: input.sessionId,
        entryId: input.entryId,
      }),
    handoffSession: (input) =>
      accept(bridge, {
        type: "handoff-session",
        requestId: input.operationId,
        sessionId: input.sessionId,
        entryId: input.entryId,
        prompt: input.prompt,
        resolveSource: input.resolveSource ?? false,
      }),
    navigateSession: (input) =>
      accept(bridge, {
        type: "navigate-session",
        requestId: input.operationId,
        sessionId: input.sessionId,
        entryId: input.entryId,
      }),
    getChangelog: (input) =>
      accept(bridge, {
        type: "get-changelog",
        requestId: input.operationId,
        sessionId: input.sessionId,
      }),
    async respondToUi(input) {
      const response = await bridge.request({
        type: "respond-ui",
        requestId: input.operationId,
        sessionId: input.sessionId,
        uiRequestId: input.uiRequestId,
        value: input.value,
        cancelled: input.cancelled,
      });
      if (response.type !== "ui-response-accepted" || response.uiRequestId !== input.uiRequestId)
        throw new Error("Cake received a mismatched UI response");
    },
    async respondToArtifact(input) {
      const response = await bridge.request({
        type: "respond-artifact",
        requestId: input.operationId,
        sessionId: input.sessionId,
        artifactRequestId: input.artifactRequestId,
        value: input.value,
        cancelled: input.cancelled,
      });
      if (
        response.type !== "artifact-response-accepted" ||
        response.artifactRequestId !== input.artifactRequestId
      )
        throw new Error("Cake received a mismatched artifact response");
    },
    async exportArtifacts(sessionId) {
      const response = await bridge.request({ type: "export-artifacts", sessionId });
      if (response.type !== "artifacts-exported")
        throw new Error("Cake could not export artifacts");
      return response.markdown;
    },
    subscribe(listener) {
      return bridge.subscribe((event) => {
        const mapped = toClientEvent(event);
        if (mapped) listener(mapped);
      });
    },
  };
}
