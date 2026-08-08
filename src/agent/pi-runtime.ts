import {
  DefaultResourceLoader,
  DefaultPackageManager,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  hasTrustRequiringProjectResources,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
  type InlineExtension
} from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Attachment,
  ModelOption,
  CompatibilityCatalog,
  ExtensionUiEvent,
  ExtensionUiState,
  ResourceDiagnostic,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
  UiPart,
  SessionTreeNode
} from "../ipc/session-contract";

export const piRuntimeVersion = "0.84.0" as const;

export function inspectWorkspace(path: string) {
  return { path, trustRequired: hasTrustRequiringProjectResources(path) };
}

export async function listWorkspaceSessions(cwd: string, sessionDir?: string): Promise<SessionSummary[]> {
  const sessions = await SessionManager.list(cwd, sessionDir);
  const idsByPath = new Map(sessions.map((item) => [item.path, item.id]));
  return sessions.map((item) => ({
    id: item.id,
    title: item.name || item.firstMessage || "New chat",
    created: item.created.toISOString(),
    modified: item.modified.toISOString(),
    messageCount: item.messageCount,
    parentSessionId: item.parentSessionPath ? idsByPath.get(item.parentSessionPath) : undefined,
    archived: false
  }));
}

export interface RuntimeUiRequest {
  kind: "confirm" | "text" | "secret" | "select" | "manual_code" | "editor";
  title: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  options?: Array<{ id: string; label: string }>;
  signal?: AbortSignal;
  timeout?: number;
}

export type CakeRuntimeEvent =
  | { type: "snapshot"; requestId?: string; snapshot: SessionSnapshot }
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming"; sessionId: string; streaming: boolean }
  | { type: "extension-ui"; sessionId: string; event: ExtensionUiEvent };

export interface CakeRuntimeOptions {
  cwd: string;
  trusted: boolean;
  agentDir?: string;
  sessionDir?: string;
  newSession?: boolean;
  sessionId?: string;
  sessionFile?: string;
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  onEvent(event: CakeRuntimeEvent): void;
}

export interface CakeRuntime {
  readonly sessionId: string;
  readonly sessionFile: string;
  snapshot(requestId?: string): Promise<SessionSnapshot>;
  prompt(text: string, delivery: "prompt" | "steer" | "follow-up", attachments: Attachment[]): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  login(provider: string, authType: "api_key" | "oauth"): Promise<void>;
  logout(provider: string): Promise<void>;
  rename(name: string): Promise<void>;
  fork(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  navigate(entryId: string): Promise<void>;
  dispose(): void;
}

function formatUnknown(value: unknown, limit = 48_000) {
  let formatted: string;
  if (typeof value === "string") formatted = value;
  else {
    try {
      formatted = JSON.stringify(value, null, 2);
    } catch {
      formatted = String(value);
    }
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…` : formatted;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && Reflect.get(item, "type") === "text" && typeof Reflect.get(item, "text") === "string")
    .map((item) => item.text)
    .join("\n");
}

function partsFromMessage(message: unknown, baseId: string, streaming = false): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const role = Reflect.get(message, "role");
  const content = Reflect.get(message, "content");

  if (role === "user") {
    const parts: UiPart[] = [];
    const text = textFromContent(content);
    if (text) parts.push({ id: `${baseId}-text`, kind: "text", role: "user", text, status: "complete" });
    if (Array.isArray(content)) {
      content.forEach((item, index) => {
        if (typeof item === "object" && item !== null && Reflect.get(item, "type") === "image") {
          parts.push({ id: `${baseId}-attachment-${index}`, kind: "attachment", name: `Image ${index + 1}`, mediaType: String(Reflect.get(item, "mimeType") ?? "image"), attachmentKind: "image" });
        }
      });
    }
    return parts;
  }

  if (role === "assistant" && Array.isArray(content)) {
    return content.flatMap((item, index): UiPart[] => {
      if (typeof item !== "object" || item === null) return [];
      const type = Reflect.get(item, "type");
      if (type === "text") {
        const text = String(Reflect.get(item, "text") ?? "");
        if (!text) return [];
        const sources = [...new Set(text.match(/https?:\/\/[^\s)\]}>,]+/g) ?? [])].slice(0, 20);
        return [
          { id: `${baseId}-text-${index}`, kind: "text", role: "assistant", text, status: streaming ? "streaming" : Reflect.get(message, "errorMessage") ? "error" : "complete" },
          ...sources.map((url, sourceIndex): UiPart => ({ id: `${baseId}-source-${index}-${sourceIndex}`, kind: "source", title: sourceTitle(url), url }))
        ];
      }
      if (type === "thinking") {
        return [{ id: `${baseId}-reasoning-${index}`, kind: "reasoning", text: String(Reflect.get(item, "thinking") ?? ""), status: streaming ? "streaming" : "complete" }];
      }
      if (type === "toolCall") {
        return [{ id: `tool-${String(Reflect.get(item, "id"))}`, kind: "tool", name: String(Reflect.get(item, "name") ?? "tool"), input: formatUnknown(Reflect.get(item, "arguments")), state: "running" }];
      }
      return [];
    });
  }

  if (role === "toolResult") {
    return [{
      id: `tool-${String(Reflect.get(message, "toolCallId"))}`,
      kind: "tool",
      name: String(Reflect.get(message, "toolName") ?? "tool"),
      input: "",
      output: textFromContent(content) || formatUnknown(Reflect.get(message, "details")),
      state: Reflect.get(message, "isError") ? "error" : "success"
    }];
  }

  if (role === "custom" && Reflect.get(message, "display") === true) {
    return [{ id: `${baseId}-custom`, kind: "notice", tone: "info", title: String(Reflect.get(message, "customType") ?? "Extension"), detail: textFromContent(content) }];
  }
  return [];
}

function projectMessages(messages: readonly unknown[]) {
  const projected: UiPart[] = [];
  const indexes = new Map<string, number>();
  for (const [messageIndex, message] of messages.entries()) {
    for (const part of partsFromMessage(message, `message-${messageIndex}`)) {
      const existingIndex = indexes.get(part.id);
      if (existingIndex === undefined) {
        indexes.set(part.id, projected.length);
        projected.push(part);
        continue;
      }
      const existing = projected[existingIndex];
      projected[existingIndex] = existing?.kind === "tool" && part.kind === "tool"
        ? { ...part, input: part.input || existing.input }
        : part;
    }
  }
  return projected;
}

function imageContent(attachments: Attachment[]) {
  return attachments.flatMap((attachment) => attachment.kind === "image"
    ? [{ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }]
    : []);
}

function promptText(text: string, attachments: Attachment[]) {
  const mentions = attachments.filter((item) => item.kind === "file").map((item) => `@${item.path}`);
  return mentions.length ? `${text}\n\n${mentions.join("\n")}` : text;
}

function sourceTitle(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
}

function entryPreview(entry: { type: string }) {
  const value = entry as unknown as Record<string, unknown>;
  if (entry.type === "message") return textFromContent((value.message as { content?: unknown } | undefined)?.content).slice(0, 2_048);
  if (entry.type === "compaction" || entry.type === "branch_summary") return String(value.summary ?? "").slice(0, 2_048);
  if (entry.type === "session_info") return String(value.name ?? "Session renamed").slice(0, 2_048);
  if (entry.type === "model_change") return `${String(value.provider ?? "")}/${String(value.modelId ?? "")}`;
  return entry.type.replaceAll("_", " ");
}

function projectTree(sessionManager: SessionManager): SessionTreeNode[] {
  const activeIds = new Set(sessionManager.getBranch().map((entry) => entry.id));
  const visit = (node: ReturnType<SessionManager["getTree"]>[number]): SessionTreeNode => ({
    id: node.entry.id,
    parentId: node.entry.parentId ?? undefined,
    type: node.entry.type,
    label: node.label,
    preview: entryPreview(node.entry),
    active: activeIds.has(node.entry.id),
    children: node.children.map(visit)
  });
  return sessionManager.getTree().map(visit);
}

function compatibilityCatalog(
  resourceLoader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  cwd: string,
  agentDir: string
): CompatibilityCatalog {
  const extensions = resourceLoader.getExtensions();
  const skills = resourceLoader.getSkills();
  const prompts = resourceLoader.getPrompts();
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages();
  const resources: CompatibilityCatalog["resources"] = [];

  for (const skill of skills.skills) resources.push({
    id: `skill:${skill.filePath}`.slice(0, 8_192), kind: "skill", name: skill.name,
    description: skill.description, path: skill.filePath, source: skill.sourceInfo.source,
    scope: skill.sourceInfo.scope, origin: skill.sourceInfo.origin, commands: [], tools: [], enabled: true
  });
  for (const prompt of prompts.prompts) resources.push({
    id: `prompt:${prompt.filePath}`.slice(0, 8_192), kind: "prompt", name: prompt.name,
    description: prompt.description, path: prompt.filePath, source: prompt.sourceInfo.source,
    scope: prompt.sourceInfo.scope, origin: prompt.sourceInfo.origin, commands: [], tools: [], enabled: true
  });
  for (const extension of extensions.extensions) resources.push({
    id: `extension:${extension.resolvedPath}`.slice(0, 8_192), kind: "extension",
    name: extension.path.split(/[\\/]/).pop() ?? extension.path, path: extension.path,
    source: extension.sourceInfo.source, scope: extension.sourceInfo.scope,
    origin: extension.sourceInfo.origin, commands: [...extension.commands.keys()].sort(),
    tools: [...extension.tools.keys()].sort(), enabled: !extension.hidden
  });
  for (const configured of packages) resources.push({
    id: `package:${configured.scope}:${configured.source}`.slice(0, 8_192), kind: "package",
    name: configured.source, path: configured.installedPath, source: configured.source,
    scope: configured.scope, origin: "package", commands: [], tools: [], enabled: !configured.filtered
  });

  const diagnostics: ResourceDiagnostic[] = [
    ...extensions.errors.map((error, index) => ({ id: `extension:${index}:${error.path}`, severity: "error" as const, source: "extension" as const, message: error.error, path: error.path })),
    ...skills.diagnostics.map((item, index) => ({ id: `skill:${index}:${item.path ?? item.message}`.slice(0, 8_192), severity: item.type === "error" ? "error" as const : "warning" as const, source: "skill" as const, message: item.message, path: item.path })),
    ...resourceLoader.getPrompts().diagnostics.map((item, index) => ({ id: `prompt:${index}:${item.path ?? item.message}`.slice(0, 8_192), severity: item.type === "error" ? "error" as const : "warning" as const, source: "prompt" as const, message: item.message, path: item.path }))
  ];
  return { resources, diagnostics };
}

function createCakeExtensionUiContext(options: {
  request(request: RuntimeUiRequest): Promise<string | undefined>;
  emit(event: ExtensionUiEvent): void;
  state: ExtensionUiState;
  addDiagnostic(method: string, message: string): void;
}): ExtensionUIContext {
  let editorText = "";
  const degraded = (method: string, detail: string) => options.addDiagnostic(method, `${method} is unavailable in Cake: ${detail}`);
  const dialog = (request: RuntimeUiRequest) => options.request(request);
  const setWidget = (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => {
    if (typeof content === "function") {
      degraded("setWidget(component)", "terminal Component factories cannot be translated to React; provide legacy string lines or a Cake widget");
      return;
    }
    const placement = widgetOptions?.placement ?? "aboveEditor";
    const index = options.state.widgets.findIndex((widget) => widget.key === key);
    if (content === undefined) {
      if (index >= 0) options.state.widgets.splice(index, 1);
      options.emit({ kind: "widget", key, placement });
      return;
    }
    const lines = Array.isArray(content) ? content.map(String).slice(0, 1_000) : [];
    const widget = { key, lines, placement };
    if (index >= 0) options.state.widgets.splice(index, 1, widget);
    else options.state.widgets.push(widget);
    options.emit({ kind: "widget", ...widget });
  };

  return {
    select: (title, values, opts) => dialog({ kind: "select", title, message: title, options: values.map((value) => ({ id: value, label: value })), signal: opts?.signal, timeout: opts?.timeout }),
    async confirm(title, message, opts) { return (await dialog({ kind: "confirm", title, message, signal: opts?.signal, timeout: opts?.timeout })) === "true"; },
    input: (title, placeholder, opts) => dialog({ kind: "text", title, message: title, placeholder, signal: opts?.signal, timeout: opts?.timeout }),
    notify(message, tone = "info") { options.emit({ kind: "notify", id: crypto.randomUUID(), message, tone }); },
    onTerminalInput() { degraded("onTerminalInput", "raw terminal input has no desktop equivalent"); return () => undefined; },
    setStatus(key, text) {
      const index = options.state.statuses.findIndex((status) => status.key === key);
      if (text === undefined) { if (index >= 0) options.state.statuses.splice(index, 1); }
      else if (index >= 0) options.state.statuses.splice(index, 1, { key, text });
      else options.state.statuses.push({ key, text });
      options.emit({ kind: "status", key, text });
    },
    setWorkingMessage(message) { degraded("setWorkingMessage", message ? "Cake owns its streaming indicator" : "Cake owns its streaming indicator"); },
    setWorkingVisible() { degraded("setWorkingVisible", "Cake owns streaming visibility"); },
    setWorkingIndicator() { degraded("setWorkingIndicator", "terminal animation frames are not web UI"); },
    setHiddenThinkingLabel() { degraded("setHiddenThinkingLabel", "Cake uses its accessible reasoning label"); },
    setWidget,
    setFooter() { degraded("setFooter", "terminal footer factories cannot run in the renderer"); },
    setHeader() { degraded("setHeader", "terminal header factories cannot run in the renderer"); },
    setTitle(title) { options.state.title = title; options.emit({ kind: "title", title }); },
    async custom() { degraded("custom", "arbitrary TUI components require a Cake artifact or widget fallback"); return undefined as never; },
    pasteToEditor(text) { editorText += text; options.emit({ kind: "editor-text", text, mode: "insert" }); },
    setEditorText(text) { editorText = text; options.emit({ kind: "editor-text", text, mode: "replace" }); },
    getEditorText: () => editorText,
    editor: (title, prefill) => dialog({ kind: "editor", title, message: title, initialValue: prefill ?? "", multiline: true }),
    addAutocompleteProvider() { degraded("addAutocompleteProvider", "terminal autocomplete providers cannot attach to the web composer"); },
    setEditorComponent() { degraded("setEditorComponent", "terminal editor components cannot replace the web composer"); },
    getEditorComponent: () => undefined,
    get theme() { degraded("theme", "Pi TUI themes are not Cake renderer themes"); return unsupported("theme"); },
    getAllThemes: () => [],
    getTheme(name) { degraded("getTheme", `Pi TUI theme ${name} is unavailable`); return undefined; },
    setTheme() { degraded("setTheme", "extensions cannot replace Cake's renderer theme"); return { success: false, error: "Pi TUI themes are unavailable in Cake" }; },
    getToolsExpanded: () => false,
    setToolsExpanded() { degraded("setToolsExpanded", "tool expansion is controlled by the Cake transcript"); }
  };
}

export async function createCakeRuntime(options: CakeRuntimeOptions): Promise<CakeRuntime> {
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.trusted });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`
  });
  const resourceLoader = new DefaultResourceLoader({ cwd: options.cwd, agentDir, settingsManager });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.trusted });
  const availableSessions = await SessionManager.list(options.cwd, options.sessionDir);
  const allowedSessionRoot = resolve(options.sessionDir ?? join(agentDir, "sessions"));
  let directSession: SessionManager | undefined;
  if (options.sessionFile) {
    const targetDirectory = resolve(dirname(options.sessionFile));
    const pathFromRoot = relative(allowedSessionRoot, targetDirectory);
    if (isAbsolute(pathFromRoot) || pathFromRoot.startsWith("..")) throw new Error("Session file is outside this workspace's Pi session directory");
    directSession = SessionManager.open(options.sessionFile, options.sessionDir, options.cwd);
  }
  const requestedSession = options.sessionId
    ? availableSessions.find((item) => item.id === options.sessionId)
    : undefined;
  if (options.sessionId && !requestedSession && !directSession) throw new Error("That session is no longer available");
  const sessionManager = options.newSession
    ? SessionManager.create(options.cwd, options.sessionDir)
    : directSession ?? (requestedSession
      ? SessionManager.open(requestedSession.path, options.sessionDir, options.cwd)
      : SessionManager.continueRecent(options.cwd, options.sessionDir));
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager
  });
  let disposed = false;
  let activeStreamId = "stream-0";
  let streamIndex = 0;
  const catalog = compatibilityCatalog(resourceLoader, settingsManager, options.cwd, agentDir);
  const extensionUiState: ExtensionUiState = { statuses: [], widgets: [] };
  const compatibilityDiagnosticKeys = new Set(catalog.diagnostics.map((item) => `${item.method ?? ""}:${item.message}`));

  const requestExtensionValue = async (request: RuntimeUiRequest) => options.requestUi(request);
  const extensionUi = createCakeExtensionUiContext({
    request: requestExtensionValue,
    state: extensionUiState,
    emit: (event) => { if (!disposed) options.onEvent({ type: "extension-ui", sessionId: session.sessionId, event }); },
    addDiagnostic(method, message) {
      const key = `${method}:${message}`;
      if (compatibilityDiagnosticKeys.has(key)) return;
      compatibilityDiagnosticKeys.add(key);
      const diagnostic: ResourceDiagnostic = { id: `compatibility:${method}:${compatibilityDiagnosticKeys.size}`, severity: "warning", source: "compatibility", method, message };
      catalog.diagnostics.push(diagnostic);
      if (!disposed) options.onEvent({ type: "extension-ui", sessionId: session.sessionId, event: { kind: "diagnostic", diagnostic } });
    }
  });
  await session.bindExtensions({ mode: "rpc", uiContext: extensionUi });

  async function modelOptions(): Promise<ModelOption[]> {
    const providers = modelRuntime.getProviders();
    const authenticated = new Map(await Promise.all(providers.map(async (provider) => [provider.id, Boolean(await modelRuntime.checkAuth(provider.id))] as const)));
    return providers.flatMap((provider) => provider.getModels().map((model) => ({
      provider: provider.id,
      providerName: provider.name,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      authenticated: authenticated.get(provider.id) ?? false,
      authTypes: [provider.auth.apiKey ? "api_key" as const : undefined, provider.auth.oauth ? "oauth" as const : undefined].filter((type): type is "api_key" | "oauth" => Boolean(type))
    })));
  }

  async function makeSnapshot(): Promise<SessionSnapshot> {
    const sessions = await listWorkspaceSessions(options.cwd, options.sessionDir);
    return {
      workspacePath: options.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? "",
      parts: projectMessages(session.messages),
      model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : undefined,
      models: await modelOptions(),
      thinkingLevel: session.thinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels(),
      streaming: session.isStreaming,
      diagnostics: [
        ...extensionsResult.errors.map((error) => `${error.path}: ${error.error}`),
        ...(modelFallbackMessage ? [modelFallbackMessage] : [])
      ],
      compatibility: catalog,
      extensionUi: extensionUiState,
      sessions,
      tree: projectTree(session.sessionManager)
    };
  }

  async function emitSnapshot(requestId?: string) {
    if (disposed) return;
    const snapshot = await makeSnapshot();
    if (disposed) return;
    options.onEvent({ type: "snapshot", requestId, snapshot });
  }

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (disposed) return;
    if (event.type === "agent_start") {
      activeStreamId = `stream-${++streamIndex}`;
      options.onEvent({ type: "streaming", sessionId: session.sessionId, streaming: true });
    }
    if (event.type === "message_update") {
      for (const part of partsFromMessage(event.message, activeStreamId, true)) {
        options.onEvent({ type: "part-updated", sessionId: session.sessionId, part });
      }
    }
    if (event.type === "message_end") {
      for (const part of partsFromMessage(event.message, activeStreamId)) {
        options.onEvent({ type: "part-updated", sessionId: session.sessionId, part });
      }
    }
    if (event.type === "tool_execution_start") {
      options.onEvent({ type: "part-updated", sessionId: session.sessionId, part: { id: `tool-${event.toolCallId}`, kind: "tool", name: event.toolName, input: formatUnknown(event.args), state: "running" } });
    }
    if (event.type === "tool_execution_update") {
      options.onEvent({ type: "part-updated", sessionId: session.sessionId, part: { id: `tool-${event.toolCallId}`, kind: "tool", name: event.toolName, input: formatUnknown(event.args), output: formatUnknown(event.partialResult), state: "running" } });
    }
    if (event.type === "tool_execution_end") {
      options.onEvent({ type: "part-updated", sessionId: session.sessionId, part: { id: `tool-${event.toolCallId}`, kind: "tool", name: event.toolName, input: "", output: formatUnknown(event.result), state: event.isError ? "error" : "success" } });
    }
    if (event.type === "auto_retry_start") {
      options.onEvent({ type: "part-updated", sessionId: session.sessionId, part: { id: "active-retry", kind: "notice", tone: "warning", title: `Retry ${event.attempt}/${event.maxAttempts}`, detail: event.errorMessage } });
    }
    if (event.type === "compaction_start") {
      options.onEvent({ type: "part-updated", sessionId: session.sessionId, part: { id: "active-compaction", kind: "notice", tone: "info", title: "Compacting context", detail: event.reason } });
    }
    if (event.type === "agent_settled") {
      options.onEvent({ type: "streaming", sessionId: session.sessionId, streaming: false });
      void emitSnapshot();
    }
  });

  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? "",
    snapshot: makeSnapshot,
    async prompt(text, delivery, attachments) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const content = promptText(text, attachments);
      const images = imageContent(attachments);
      if (delivery === "steer") await session.steer(content, images);
      else if (delivery === "follow-up") await session.followUp(content, images);
      else await session.prompt(content, { images, source: "interactive" });
    },
    abort: () => session.abort(),
    async setModel(provider, modelId) {
      const model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
      await session.setModel(model);
      await emitSnapshot();
    },
    async setThinkingLevel(level) {
      session.setThinkingLevel(level);
      await emitSnapshot();
    },
    async login(provider, authType) {
      await modelRuntime.login(provider, authType, {
        async prompt(prompt) {
          const value = await requestExtensionValue({
            kind: prompt.type,
            title: "Provider authentication",
            message: prompt.message,
            placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
            options: prompt.type === "select" ? prompt.options.map((option) => ({ id: option.id, label: option.label })) : undefined,
            signal: prompt.signal
          });
          if (value === undefined) throw new Error("Authentication cancelled");
          return value;
        },
        notify(event) {
          const detail = event.type === "auth_url" ? event.url : event.type === "device_code" ? `${event.verificationUri}\nCode: ${event.userCode}` : event.message;
          options.onEvent({ type: "part-updated", sessionId: session.sessionId, part: { id: "auth-status", kind: "notice", tone: "info", title: "Authentication", detail } });
        }
      });
      await emitSnapshot();
    },
    async logout(provider) {
      await modelRuntime.logout(provider);
      await emitSnapshot();
    },
    async rename(name) {
      session.setSessionName(name.trim());
      await emitSnapshot();
    },
    async fork(entryId) {
      const sessionFile = session.sessionManager.createBranchedSession(entryId);
      if (!sessionFile) throw new Error("The current session is not persisted");
      const forked = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
      return { sessionId: forked.getSessionId(), sessionFile };
    },
    async navigate(entryId) {
      const result = await session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("Session tree navigation was cancelled");
      await emitSnapshot();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      session.dispose();
      void settingsManager.flush();
    }
  };
}

export type FoundationRuntimeEvent =
  | { type: "text-delta"; text: string }
  | { type: "session-ready"; sessionId: string };

export interface FoundationRuntimeOptions {
  cwd: string;
  agentDir: string;
  requestConfirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
  onEvent(event: FoundationRuntimeEvent): void;
}

export interface FoundationRuntime {
  readonly sessionId: string;
  readonly sessionFile: undefined;
  run(): Promise<void>;
  dispose(): void;
}

const foundationExtension: InlineExtension = (pi) => {
  pi.registerCommand("cake-foundation", {
    description: "Exercise Cake's Pi session and extension UI boundaries",
    async handler(_args, ctx) {
      const accepted = await ctx.ui.confirm(
        "Pi extension confirmation",
        "This request came from a Pi extension running outside the renderer."
      );
      const chunks = accepted
        ? ["Pi", " session", " boundary", " is", " alive."]
        : ["Pi", " extension", " confirmation", " was", " declined."];

      for (const content of chunks) {
        pi.sendMessage({ customType: "cake.foundation", content, display: true });
      }
    }
  });
};

function unsupported(name: string): never {
  throw new Error(`Pi extension UI method ${name} is not supported by the S0 Cake adapter`);
}

function createFoundationUiContext(
  requestConfirm: FoundationRuntimeOptions["requestConfirm"]
): ExtensionUIContext {
  const noop = () => undefined;

  return {
    select: async () => undefined,
    confirm: (title, message, options) => requestConfirm(title, message, options?.signal),
    input: async () => undefined,
    notify: noop,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => unsupported("custom"),
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    get theme() {
      return unsupported("theme");
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme selection is not supported in S0" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop
  };
}

function projectEvent(event: AgentSessionEvent): FoundationRuntimeEvent | undefined {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    return { type: "text-delta", text: event.assistantMessageEvent.delta };
  }

  if (
    event.type === "message_end" &&
    event.message.role === "custom" &&
    event.message.customType === "cake.foundation" &&
    typeof event.message.content === "string"
  ) {
    return { type: "text-delta", text: event.message.content };
  }

  return undefined;
}

export async function createFoundationRuntime(
  options: FoundationRuntimeOptions
): Promise<FoundationRuntime> {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories: [foundationExtension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    noTools: "all",
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager
  });
  const unsubscribe = session.subscribe((event) => {
    const projected = projectEvent(event);
    if (projected) options.onEvent(projected);
  });

  await session.bindExtensions({
    mode: "rpc",
    uiContext: createFoundationUiContext(options.requestConfirm)
  });
  options.onEvent({ type: "session-ready", sessionId: session.sessionId });

  let disposed = false;
  return {
    sessionId: session.sessionId,
    sessionFile: undefined,
    async run() {
      if (disposed) throw new Error("The Pi foundation runtime has been disposed");
      await session.prompt("/cake-foundation", { source: "extension" });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      session.dispose();
    }
  };
}
