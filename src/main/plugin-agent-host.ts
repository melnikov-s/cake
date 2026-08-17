import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WebContents } from "electron";
import { runBoundedCompletion } from "../agent/utility-model";
import type { CakeRuntimeEvent } from "../agent/cake-runtime";
import {
  PLUGIN_COMPLETION_INPUT_MAX,
  type AgentModelPreference,
  type PluginAgentOpenOptions,
  type PluginAgentSnapshot,
  type PluginCompletionRequest,
  type PluginCompletionResult,
  type PluginSessionActivity,
  type ResolvedAgentModel,
  type SessionRef,
  type WorkspaceRef
} from "../ipc/plugin-agent-contract";
import type { DesktopEvent } from "../ipc/desktop-ipc";
import type { SessionSnapshot, ThinkingLevel, UiPart, UtilityModel } from "../ipc/session-contract";
import type { PiWorkspaceDriver } from "./pi-workspace-driver";

interface Handle {
  pluginId: string;
  ownerId: number;
  handleId: string;
  workspacePath: string;
  sessionId: string;
  ref: SessionRef;
  driver: PiWorkspaceDriver;
  resolvedModel: ResolvedAgentModel;
  status: "idle" | "running" | "error";
  settledRevision: string;
  error?: string;
  unsubscribe(): void;
}

const encodeRef = (value: unknown) => JSON.stringify(value);
const decodeRef = (id: string): unknown => JSON.parse(id);

export function workspaceRef(workspacePath: string): WorkspaceRef {
  return { kind: "cake.workspace-ref", id: encodeRef({ workspacePath }) };
}

export function sessionRef(workspacePath: string, sessionId: string): SessionRef {
  return { kind: "cake.session-ref", id: encodeRef({ workspacePath, sessionId }) };
}

export function resolveWorkspaceRef(ref: WorkspaceRef) {
  const value = decodeRef(ref.id);
  if (!value || typeof value !== "object" || !("workspacePath" in value) || typeof value.workspacePath !== "string") throw new Error("Invalid Cake workspace reference");
  return value.workspacePath;
}

export function resolveSessionRef(ref: SessionRef) {
  const value = decodeRef(ref.id);
  if (!value || typeof value !== "object" || !("workspacePath" in value) || !("sessionId" in value) || typeof value.workspacePath !== "string" || typeof value.sessionId !== "string") throw new Error("Invalid Cake session reference");
  return { workspacePath: value.workspacePath, sessionId: value.sessionId };
}

function fallbackReason(snapshot: SessionSnapshot, provider: string, modelId: string) {
  const model = snapshot.models.find((item) => item.provider === provider && item.id === modelId);
  if (!model) return "unknown-model" as const;
  if (!model.authenticated) return "not-authenticated" as const;
  return undefined;
}

export function resolveAgentModel(preference: AgentModelPreference, snapshot: SessionSnapshot, utility: UtilityModel | undefined): ResolvedAgentModel {
  const fallbacks: ResolvedAgentModel["fallbacks"] = [];
  const accept = (source: ResolvedAgentModel["source"], provider: string | undefined, modelId: string | undefined, thinkingLevel: ThinkingLevel | undefined) => {
    if (!provider || !modelId) {
      if (source !== "exact") fallbacks.push({ source, reason: "not-configured" });
      return undefined;
    }
    const reason = fallbackReason(snapshot, provider, modelId);
    if (reason) {
      if (source === "exact") throw new Error(`Requested model ${provider}/${modelId} is ${reason === "unknown-model" ? "unknown" : "not authenticated"}`);
      fallbacks.push({ source, reason });
      return undefined;
    }
    return { requested: preference.prefer, source, provider, modelId, thinkingLevel: thinkingLevel ?? "medium", fallbacks } satisfies ResolvedAgentModel;
  };
  if (preference.prefer === "exact") {
    return accept("exact", preference.provider, preference.modelId, preference.thinkingLevel ?? snapshot.thinkingLevel)!;
  }
  if (preference.prefer === "utility") {
    const resolved = accept("utility", utility?.provider, utility?.modelId, utility?.thinkingLevel);
    if (resolved) return resolved;
  }
  if (preference.prefer === "utility" || preference.prefer === "default") {
    const resolved = accept("default", snapshot.piSettings?.defaultProvider, snapshot.piSettings?.defaultModel, snapshot.piSettings?.defaultThinkingLevel);
    if (resolved) return resolved;
  }
  const current = snapshot.model && accept("current", snapshot.model.provider, snapshot.model.id, snapshot.thinkingLevel);
  if (current) return current;
  throw new Error("The calling session has no available current model");
}

function activity(snapshot: SessionSnapshot): PluginSessionActivity {
  const messages = snapshot.parts.filter((part): part is Extract<UiPart, { kind: "text" }> => part.kind === "text" && Boolean(part.entryId));
  const last = messages.at(-1);
  const leafId = [...snapshot.parts].reverse().flatMap((part) => "entryId" in part && part.entryId ? [part.entryId] : [])[0];
  const settledRevision = createHash("sha256").update(JSON.stringify(snapshot.parts.map((part) => part.kind === "text" ? [part.id, part.entryId, part.role, part.text, part.status] : [part.id, part.kind]))).digest("hex");
  return { streaming: snapshot.streaming, settledRevision, leafId, lastMessageId: last?.entryId };
}

function contextText(snapshot: SessionSnapshot, request: PluginCompletionRequest) {
  const messages = snapshot.parts.filter((part): part is Extract<UiPart, { kind: "text" }> => part.kind === "text" && part.status !== "streaming");
  const selection = request.context.selection;
  let selected: typeof messages;
  if (selection === "last-message") selected = messages.slice(-1);
  else if (selection === "last-user-message") selected = messages.filter((part) => part.role === "user").slice(-1);
  else if (selection === "last-assistant-message") selected = messages.filter((part) => part.role === "assistant").slice(-1);
  else if (selection.kind === "recent-messages") selected = messages.slice(-selection.count);
  else selected = messages;
  const maximum = typeof selection === "object" && selection.kind === "current-branch" ? selection.maximumInputCharacters : PLUGIN_COMPLETION_INPUT_MAX;
  const text = selected.map((part) => `<${part.role}>\n${part.text}\n</${part.role}>`).join("\n\n");
  return text.length <= maximum ? text : text.slice(text.length - maximum);
}

export class PluginAgentHost {
  private readonly handles = new Map<string, Handle>();
  private readonly privateRefs = new Map<string, { pluginId: string; workspacePath: string; sessionId: string }>();
  private readonly completionCache = new Map<string, PluginCompletionResult>();

  constructor(private readonly options: {
    agentDir: string;
    utilityModel(): UtilityModel | undefined;
    driver(workspacePath: string): PiWorkspaceDriver;
    emit(owner: WebContents, event: DesktopEvent): void;
  }) {}

  async open(owner: WebContents, pluginId: string, open: PluginAgentOpenOptions, implicit?: SessionRef): Promise<PluginAgentSnapshot> {
    const implicitTarget = implicit ? this.resolveSession(pluginId, implicit) : undefined;
    let workspacePath: string;
    let target: Parameters<PiWorkspaceDriver["openAgent"]>[0]["target"];
    if (open.session.kind === "new") {
      workspacePath = open.session.workspace ? resolveWorkspaceRef(open.session.workspace) : implicitTarget?.workspacePath ?? "";
      if (!workspacePath) throw new Error("A new plugin agent requires a workspace context");
      target = { kind: "new", visibility: open.session.visibility };
    } else if (open.session.kind === "attach") {
      const resolved = open.session.target ? this.resolveSession(pluginId, open.session.target) : implicitTarget;
      if (!resolved) throw new Error("Attaching a plugin agent requires a session context");
      workspacePath = resolved.workspacePath;
      target = { kind: "attach", sessionId: resolved.sessionId };
    } else {
      const resolved = open.session.source ? this.resolveSession(pluginId, open.session.source) : implicitTarget;
      if (!resolved) throw new Error("Forking a plugin agent requires a session context");
      workspacePath = resolved.workspacePath;
      target = { kind: "fork", sessionId: resolved.sessionId, entryId: open.session.entryId, visibility: open.session.visibility };
    }
    const driver = this.options.driver(workspacePath);
    let snapshot = await driver.openAgent({ target, instructions: open.instructions });
    const resolvedModel = resolveAgentModel(open.model, snapshot, this.options.utilityModel());
    const modelAlreadySelected = snapshot.model?.provider === resolvedModel.provider && snapshot.model.id === resolvedModel.modelId && snapshot.thinkingLevel === resolvedModel.thinkingLevel;
    if (!modelAlreadySelected) {
      if (snapshot.streaming) throw new Error("Cannot change the model profile while the attached agent is running");
      snapshot = await driver.configureAgent(snapshot.sessionId, resolvedModel.provider, resolvedModel.modelId, resolvedModel.thinkingLevel);
    }
    const handleId = crypto.randomUUID();
    const privateSession = (open.session.kind === "new" || open.session.kind === "fork") && open.session.visibility === "private";
    const ref = privateSession ? { kind: "cake.session-ref" as const, id: crypto.randomUUID() } : sessionRef(workspacePath, snapshot.sessionId);
    if (privateSession) this.privateRefs.set(ref.id, { pluginId, workspacePath, sessionId: snapshot.sessionId });
    const handle: Handle = { pluginId, ownerId: owner.id, handleId, workspacePath, sessionId: snapshot.sessionId, ref, driver, resolvedModel, status: snapshot.streaming ? "running" : "idle", settledRevision: activity(snapshot).settledRevision, unsubscribe: () => undefined };
    handle.unsubscribe = driver.subscribeAgent(snapshot.sessionId, (event) => this.receive(owner, handle, event));
    this.handles.set(handleId, handle);
    return this.project(handle, snapshot);
  }

  async command(owner: WebContents, pluginId: string, handleId: string, delivery: "prompt" | "steer" | "follow-up", text: string) {
    const handle = this.requireHandle(owner, pluginId, handleId);
    handle.status = "running";
    try {
      const snapshot = await handle.driver.agentPrompt(handle.sessionId, text, delivery);
      handle.status = snapshot.streaming ? "running" : "idle";
      return this.project(handle, snapshot);
    } catch (error) {
      handle.status = "error";
      handle.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async abort(owner: WebContents, pluginId: string, handleId: string) {
    const handle = this.requireHandle(owner, pluginId, handleId);
    const snapshot = await handle.driver.agentAbort(handle.sessionId);
    handle.status = "idle";
    return this.project(handle, snapshot);
  }

  detach(owner: WebContents, pluginId: string, handleId: string) {
    const handle = this.requireHandle(owner, pluginId, handleId);
    handle.unsubscribe();
    this.handles.delete(handleId);
  }

  async complete(pluginId: string, request: PluginCompletionRequest, implicit?: SessionRef, signal?: AbortSignal): Promise<PluginCompletionResult> {
    const target = request.context.target ? this.resolveSession(pluginId, request.context.target) : implicit ? this.resolveSession(pluginId, implicit) : undefined;
    if (!target) throw new Error("A plugin completion requires a session context");
    const snapshot = await this.options.driver(target.workspacePath).agentSnapshot(target.sessionId);
    if (snapshot.streaming) throw new Error("Session context is still streaming; wait for settledRevision to change");
    const resolvedModel = resolveAgentModel(request.model, snapshot, this.options.utilityModel());
    const sourceRevision = activity(snapshot).settledRevision;
    const cacheKey = createHash("sha256").update(JSON.stringify({ pluginId, target, sourceRevision, instructions: request.instructions, selection: request.context.selection, maximumOutputCharacters: request.maximumOutputCharacters, resolvedModel })).digest("hex");
    const cached = this.completionCache.get(cacheKey);
    if (cached) return cached;
    const completionSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const modelRuntime = await ModelRuntime.create({ authPath: `${this.options.agentDir}/auth.json`, modelsPath: `${this.options.agentDir}/models.json`, modelsStorePath: `${this.options.agentDir}/models-cache.json`, signal: completionSignal });
    const text = await runBoundedCompletion({ modelRuntime, model: resolvedModel, instructions: request.instructions, context: contextText(snapshot, request), maximumOutputCharacters: request.maximumOutputCharacters, signal: completionSignal });
    const latest = await this.options.driver(target.workspacePath).agentSnapshot(target.sessionId);
    if (activity(latest).settledRevision !== sourceRevision) throw new Error("The session context changed while the plugin completion was running");
    const result = { text, resolvedModel, sourceRevision };
    this.completionCache.set(cacheKey, result);
    if (this.completionCache.size > 256) this.completionCache.delete(this.completionCache.keys().next().value!);
    return result;
  }

  disposeOwner(ownerId: number) {
    for (const [id, handle] of this.handles) if (handle.ownerId === ownerId) { handle.unsubscribe(); this.handles.delete(id); }
  }

  private requireHandle(owner: WebContents, pluginId: string, handleId: string) {
    const handle = this.handles.get(handleId);
    if (!handle || handle.ownerId !== owner.id || handle.pluginId !== pluginId) throw new Error("Plugin agent handle is unavailable to this caller");
    return handle;
  }

  private project(handle: Handle, snapshot: SessionSnapshot): PluginAgentSnapshot {
    const projectedActivity = activity(snapshot);
    if (!snapshot.streaming) handle.settledRevision = projectedActivity.settledRevision;
    projectedActivity.settledRevision = handle.settledRevision;
    return { handleId: handle.handleId, ref: handle.ref, workspace: workspaceRef(handle.workspacePath), resolvedModel: handle.resolvedModel, status: handle.status, parts: snapshot.parts, usage: snapshot.usage, activity: projectedActivity, error: handle.error };
  }

  private receive(owner: WebContents, handle: Handle, event: CakeRuntimeEvent) {
    if (event.type === "streaming") handle.status = event.streaming ? "running" : "idle";
    void handle.driver.agentSnapshot(handle.sessionId).then((snapshot) => this.options.emit(owner, { type: "plugin-agent-event", pluginId: handle.pluginId, snapshot: this.project(handle, snapshot) })).catch(() => undefined);
  }

  private resolveSession(pluginId: string, ref: SessionRef) {
    const privateTarget = this.privateRefs.get(ref.id);
    if (privateTarget) {
      if (privateTarget.pluginId !== pluginId) throw new Error("Private plugin session references are scoped to their owning plugin");
      return { workspacePath: privateTarget.workspacePath, sessionId: privateTarget.sessionId };
    }
    return resolveSessionRef(ref);
  }
}
