import type { CakeDesktopBridge, DesktopEvent } from "../ipc/desktop-ipc";
import type {
  Attachment,
  ApplicationState,
  FileSuggestion,
  UtilityModel,
} from "../ipc/session-contract";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { SourceLocation } from "../ipc/source-location";
import type { EditorAnnotationSnapshot } from "../ipc/editor-annotation";
import type {
  WorktreeLandOutcome,
  WorktreeLandRequest,
  WorktreeRecord,
  WorktreeStatus,
} from "../ipc/worktree-contract";
import type { CustomizationState, PluginDiagnostic, PluginStatus } from "../plugin/plugin-contract";
import type {
  CompiledInlineWidget,
  InlineWidgetCapability,
  InlineWidgetLanguage,
  RepairedInlineWidget,
} from "../ipc/inline-widget-contract";
import type { JsonValue } from "../ipc/json-contract";
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
  | {
      type: "changelog-received";
      operationId: string;
      workspacePath: string;
      sessionId: string;
      markdown: string;
    }
  | {
      type: "artifact-requested";
      operationId: string;
      artifactRequestId: string;
      record: ArtifactRecord;
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
  | {
      type: "notification";
      tone: "info" | "warning" | "error";
      title: string;
      message: string;
    }
  | { type: "plugin-agent-event"; pluginId: string; snapshot: PluginAgentSnapshot }
  | { type: "terminal-data"; terminalId: string; data: string }
  | { type: "terminal-exited"; terminalId: string; exitCode: number }
  | { type: "terminal-toggle-requested" }
  | { type: "embedded-editor-state-received"; status: EmbeddedEditorStatus; message?: string }
  | {
      type: "embedded-editor-location-opened";
      workspacePath: string;
      location: SourceLocation;
    }
  | {
      type: "embedded-editor-selection";
      workspacePath: string;
      path: string;
      startLine: number;
      endLine: number;
    }
  | { type: "embedded-editor-back-to-agent"; workspacePath: string }
  | {
      type: "embedded-editor-annotation-opened";
      workspacePath: string;
      sessionId: string;
      threadId: string;
    }
  | { type: "embedded-editor-toggle-chat"; workspacePath: string }
  | { type: "embedded-editor-selection-cleared"; workspacePath: string };

export interface DesktopClient {
  chooseProject(): Promise<string | undefined>;
  openExternalUrl(url: string): Promise<void>;
  showTranscriptSelectionContextMenu(input: {
    canChat: boolean;
    canAnnotate: boolean;
  }): Promise<"chat-about-selection" | "add-annotation" | undefined>;
  showComposerContextMenu(input: {
    selection: string;
    x: number;
    y: number;
  }): Promise<"reword" | "reword-with-prompt" | undefined>;
  rewordComposerSelection(input: {
    selection: string;
    prompt?: string;
    workspacePath?: string;
  }): Promise<string>;
  generateSessionTitle?(firstUserMessage: string): Promise<string | undefined>;
  showSessionContextMenu(input: {
    sessionId: string;
    x: number;
    y: number;
    resolved: boolean;
    unread?: boolean;
  }): Promise<"rename" | "mark-unread" | "resolve" | "unresolve" | "delete" | undefined>;
  showProjectContextMenu(input: {
    path: string;
    x: number;
    y: number;
    resolvedWorktreeCount: number;
  }): Promise<"remove-project" | "delete-resolved-worktrees" | undefined>;
  openTerminal?(input: {
    target:
      | { kind: "project"; sessionId: string; workspacePath: string }
      | { kind: "cake-chat"; sessionId: string };
    cols: number;
    rows: number;
  }): Promise<{ terminalId: string; shell: string }>;
  writeTerminal?(terminalId: string, data: string): Promise<void>;
  resizeTerminal?(terminalId: string, cols: number, rows: number): Promise<void>;
  getTerminalStatus?(terminalId: string): Promise<{ runningProgram: boolean }>;
  closeTerminal?(terminalId: string): Promise<void>;
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
  registerProject(path: string, name: string): Promise<ApplicationState>;
  renameProject(path: string, name: string): Promise<ApplicationState>;
  removeProject(path: string, deleteSessions: boolean): Promise<ApplicationState>;
  deleteSession(sessionId: string): Promise<ApplicationState>;
  setSessionUnread(sessionId: string, unread: boolean): Promise<ApplicationState>;
  restartPi(path: string): Promise<void>;
  inspectWorkspace(input: { operationId: string; path: string }): Promise<void>;
  respondToWorkspaceTrust(input: {
    operationId: string;
    path: string;
    approved: boolean;
  }): Promise<void>;
  createWorktree(input: {
    operationId: string;
    path: string;
    baseWorktreePath?: string;
    worktreeName?: string;
    firstUserMessage?: string;
  }): Promise<WorktreeRecord>;
  getWorktreeStatus(input: { workspacePath: string }): Promise<WorktreeStatus | undefined>;
  landWorktree(input: {
    operationId: string;
    workspacePath: string;
    request: WorktreeLandRequest;
  }): Promise<WorktreeLandOutcome>;
  discardWorktree(input: {
    operationId: string;
    workspacePath: string;
    keepBranch: boolean;
  }): Promise<void>;
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
  if (event.type === "plugin-agent-event") return event;
  if (event.type === "artifact-requested")
    return {
      type: "artifact-requested",
      operationId: event.requestId,
      artifactRequestId: event.artifactRequestId,
      record: event.record,
    };
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
  if (event.type === "application-state-changed" || event.type === "notification") return event;
  if (
    event.type === "terminal-data" ||
    event.type === "terminal-exited" ||
    event.type === "terminal-toggle-requested"
  )
    return event;
  if (event.type === "embedded-editor-state")
    return {
      type: "embedded-editor-state-received",
      status: event.status,
      message: event.message,
    };
  if (
    event.type === "embedded-editor-selection" ||
    event.type === "embedded-editor-annotation-opened" ||
    event.type === "embedded-editor-back-to-agent" ||
    event.type === "embedded-editor-toggle-chat" ||
    event.type === "embedded-editor-selection-cleared" ||
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
    async openExternalUrl(url) {
      const response = await bridge.request({ type: "open-external-url", url });
      if (response.type !== "external-url-opened")
        throw new Error("Cake received an invalid external-link response");
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
    async showComposerContextMenu(input) {
      const response = await bridge.request({ type: "show-composer-context-menu", ...input });
      if (response.type !== "composer-context-menu-closed")
        throw new Error("Cake received an invalid composer context menu response");
      return response.action;
    },
    async rewordComposerSelection(input) {
      const response = await bridge.request({ type: "reword-composer-selection", ...input });
      if (response.type !== "composer-selection-reworded")
        throw new Error("Cake received an invalid composer rewrite response");
      return response.text;
    },
    async generateSessionTitle(firstUserMessage) {
      const response = await bridge.request({ type: "generate-session-title", firstUserMessage });
      if (response.type !== "session-title-generated")
        throw new Error("Cake received an invalid session title response");
      return response.title;
    },
    async showSessionContextMenu(input) {
      const response = await bridge.request({ type: "show-session-context-menu", ...input });
      if (response.type !== "session-context-menu-closed")
        throw new Error("Cake received an invalid session context menu response");
      return response.action;
    },
    async showProjectContextMenu(input) {
      const response = await bridge.request({ type: "show-project-context-menu", ...input });
      if (response.type !== "project-context-menu-closed")
        throw new Error("Cake received an invalid project context menu response");
      return response.action;
    },
    async openTerminal(input) {
      const requestId = crypto.randomUUID();
      const response = await bridge.request({ type: "open-terminal", requestId, ...input });
      if (response.type !== "terminal-opened" || response.requestId !== requestId)
        throw new Error("Cake could not open the terminal");
      return { terminalId: response.terminalId, shell: response.shell };
    },
    async writeTerminal(terminalId, data) {
      await accept(bridge, {
        type: "write-terminal",
        requestId: crypto.randomUUID(),
        terminalId,
        data,
      });
    },
    async resizeTerminal(terminalId, cols, rows) {
      await accept(bridge, {
        type: "resize-terminal",
        requestId: crypto.randomUUID(),
        terminalId,
        cols,
        rows,
      });
    },
    async getTerminalStatus(terminalId) {
      const requestId = crypto.randomUUID();
      const response = await bridge.request({
        type: "get-terminal-status",
        requestId,
        terminalId,
      });
      if (response.type !== "terminal-status" || response.requestId !== requestId)
        throw new Error("Cake could not inspect the terminal");
      return { runningProgram: response.runningProgram };
    },
    async closeTerminal(terminalId) {
      await accept(bridge, {
        type: "close-terminal",
        requestId: crypto.randomUUID(),
        terminalId,
      });
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
    async removeProject(path, deleteSessions) {
      const response = await bridge.request({ type: "remove-project", path, deleteSessions });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not remove the project");
      return response.state;
    },
    async deleteSession(sessionId) {
      const response = await bridge.request({ type: "delete-session", sessionId });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not delete the session");
      return response.state;
    },
    async setSessionUnread(sessionId, unread) {
      const response = await bridge.request({ type: "set-session-unread", sessionId, unread });
      if (response.type !== "application-state-updated")
        throw new Error("Cake could not update the session");
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
    async createWorktree(input) {
      const response = await bridge.request({
        type: "create-worktree",
        requestId: input.operationId,
        path: input.path,
        baseWorktreePath: input.baseWorktreePath,
        worktreeName: input.worktreeName,
        firstUserMessage: input.firstUserMessage,
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
        request: input.request,
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
