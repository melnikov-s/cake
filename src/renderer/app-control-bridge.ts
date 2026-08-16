import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../ipc/json-contract";
import type { GlobalSessionSummary, ProjectRecord, UiPart } from "../ipc/session-contract";
import {
  customizationStateSchema,
  pluginIdSchema,
  pluginStatusSchema,
  type CustomizationState,
  type PluginDiagnostic,
  type PluginStatus
} from "../plugin/plugin-contract";

const sessionTargetSchema = z.object({
  workspacePath: z.string().min(1).max(4_096),
  sessionId: z.string().min(1).max(256)
});

const sessionPageSchema = z.object({
  workspacePath: z.string().min(1).max(4_096).optional(),
  includeArchived: z.boolean().default(false),
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(200).default(100)
});

const sessionReadSchema = sessionTargetSchema.extend({
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20)
});

const searchSessionsSchema = z.object({
  query: z.string().trim().min(1).max(500),
  workspacePath: z.string().min(1).max(4_096).optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(10)
});

const emptyArgumentsSchema = z.object({}).strict();
const pluginStatusesSchema = z.array(pluginStatusSchema).max(1_000);
const pluginFileSchema = z.object({ pluginId: pluginIdSchema, path: z.string().min(1).max(8_192).describe("Path relative to the plugin directory.") });
const appControlArgumentSchemas = {
  get_app_state: emptyArgumentsSchema,
  get_customization_state: emptyArgumentsSchema,
  get_plugin_authoring_reference: emptyArgumentsSchema,
  list_plugin_files: emptyArgumentsSchema,
  create_plugin: z.object({ pluginId: pluginIdSchema, name: z.string().trim().min(1).max(128), renderer: z.boolean().default(true), backend: z.boolean().default(false), scene: z.boolean().default(false), expectedWorkingRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
  read_plugin_file: pluginFileSchema,
  write_plugin_file: pluginFileSchema.extend({ content: z.string().max(2_000_000), expectedWorkingRevision: z.string().regex(/^[a-f0-9]{64}$/) }),
  validate_customization: z.object({ expectedBaseRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), expectedSourceRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), request: z.string().trim().min(1).max(8_192) }),
  activate_customization: z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), expectedSourceRevision: z.string().regex(/^[a-f0-9]{64}$/), request: z.string().trim().min(1).max(8_192) }),
  rollback_customization: emptyArgumentsSchema,
  use_factory_customization: emptyArgumentsSchema,
  set_plugin_enabled: z.object({ pluginId: pluginIdSchema, enabled: z.boolean() }),
  set_active_scene: z.object({ pluginId: pluginIdSchema.optional() }),
  get_session_status: sessionTargetSchema,
  open_session: sessionTargetSchema,
  list_sessions: sessionPageSchema,
  read_session: sessionReadSchema,
  search_sessions: searchSessionsSchema,
  create_session: z.object({ workspacePath: z.string().min(1).max(4_096) }),
  send_session_message: sessionTargetSchema.extend({ text: z.string().trim().min(1).max(100_000), delivery: z.enum(["prompt", "follow-up", "steer"]).optional() }),
  abort_session: sessionTargetSchema,
  rename_session: sessionTargetSchema.extend({ title: z.string().trim().min(1).max(500) }),
  set_session_archived: sessionTargetSchema.extend({ archived: z.boolean() }),
  set_session_model: sessionTargetSchema.extend({ provider: z.string().trim().min(1).max(100), modelId: z.string().trim().min(1).max(200) })
} as const;

function invocation<Name extends keyof typeof appControlArgumentSchemas>(name: Name) {
  return z.object({ name: z.literal(name), arguments: appControlArgumentSchemas[name] });
}

export const appControlInvocationSchema = z.discriminatedUnion("name", [
  invocation("get_app_state"), invocation("get_customization_state"), invocation("get_plugin_authoring_reference"),
  invocation("list_plugin_files"), invocation("create_plugin"), invocation("read_plugin_file"), invocation("write_plugin_file"),
  invocation("validate_customization"), invocation("activate_customization"), invocation("rollback_customization"),
  invocation("use_factory_customization"), invocation("set_plugin_enabled"), invocation("set_active_scene"),
  invocation("get_session_status"), invocation("open_session"), invocation("list_sessions"), invocation("read_session"),
  invocation("search_sessions"), invocation("create_session"), invocation("send_session_message"), invocation("abort_session"),
  invocation("rename_session"), invocation("set_session_archived"), invocation("set_session_model")
]);

export type AppControlInvocation = z.infer<typeof appControlInvocationSchema>;

export const appControlToolCatalog = [
  tool("get_app_state", "Read Cake's current selection and a compact summary of projects and recent or active sessions.", appControlArgumentSchemas.get_app_state),
  tool("get_customization_state", "Read the exact customization source/head revisions, recovery diagnostics, last-known-good revision, and installed plugin status.", appControlArgumentSchemas.get_customization_state),
  tool("get_plugin_authoring_reference", "Read Cake's exact, version-matched plugin API and authoring guide. Always call this before creating or changing a plugin; do not probe the compiler to discover APIs.", appControlArgumentSchemas.get_plugin_authoring_reference),
  tool("list_plugin_files", "List plugin-owned source files and return exact optimistic working and build revisions. Call before creating or writing plugin source.", appControlArgumentSchemas.list_plugin_files),
  tool("create_plugin", "Create a manifest and safe starter modules for one plugin. For normal widgets use renderer=true and scene=false. Set scene=true only when the user explicitly asks to replace Cake's entire scene.", appControlArgumentSchemas.create_plugin),
  tool("read_plugin_file", "Read one text file from an exact plugin directory.", appControlArgumentSchemas.read_plugin_file),
  tool("write_plugin_file", "Atomically create or replace one plugin-owned text file, rejecting the write if plugin source changed since the supplied revision. Never create a scene module for ordinary widget work.", appControlArgumentSchemas.write_plugin_file),
  tool("validate_customization", "Typecheck and bundle current plugin source without activating or reloading it. Fix all diagnostics, then validate again. Validation is safe for iteration and must not be used as API reflection; read the authoring reference instead.", appControlArgumentSchemas.validate_customization),
  tool("activate_customization", "Activate one already validated, unchanged revision. Call only after the requested implementation is complete and validation succeeded; this reloads Cake and may start trusted plugin backends.", appControlArgumentSchemas.activate_customization),
  tool("rollback_customization", "Roll back a broken or unwanted customization to the retained last-known-good renderer.", appControlArgumentSchemas.rollback_customization),
  tool("use_factory_customization", "Select immutable Cake factory UI without deleting editable plugin source or persistence.", appControlArgumentSchemas.use_factory_customization),
  tool("set_plugin_enabled", "Enable or disable one exact plugin. Disabling preserves its source and persistence and requires rebuilding scene references.", appControlArgumentSchemas.set_plugin_enabled),
  tool("set_active_scene", "Choose an enabled plugin's optional scene as the whole-app scene, or omit pluginId to use Cake's default scene. Ordinary widgets do not need this.", appControlArgumentSchemas.set_active_scene),
  tool("get_session_status", "Inspect whether a known session is selected, running, unread, or idle.", appControlArgumentSchemas.get_session_status),
  tool("open_session", "Open a known Cake session in its project.", appControlArgumentSchemas.open_session),
  tool("list_sessions", "List Cake sessions by recency, optionally limited to one project or including archived sessions.", appControlArgumentSchemas.list_sessions),
  tool("read_session", "Read a bounded page of displayable parts from a known Cake session without opening it.", appControlArgumentSchemas.read_session),
  tool("search_sessions", "Search session titles and transcript contents without opening sessions.", appControlArgumentSchemas.search_sessions),
  tool("create_session", "Start a new session in a known Cake project and open it.", appControlArgumentSchemas.create_session),
  tool("send_session_message", "Send an instruction to a known session without opening it. Use only when the user explicitly asks to send or delegate work.", appControlArgumentSchemas.send_session_message),
  tool("abort_session", "Stop a known session that is currently running.", appControlArgumentSchemas.abort_session),
  tool("rename_session", "Rename a known session.", appControlArgumentSchemas.rename_session),
  tool("set_session_archived", "Archive or restore a known session.", appControlArgumentSchemas.set_session_archived),
  tool("set_session_model", "Change the model for one known session. Use provider and model IDs returned by Cake settings.", appControlArgumentSchemas.set_session_model)
] as const;

export interface AppControlHost {
  currentSession(): { workspacePath: string; sessionId: string } | undefined;
  projects(): readonly ProjectRecord[];
  sessions(): readonly GlobalSessionSummary[];
  sessionActivity(workspacePath: string, sessionId: string): "running" | "unread" | undefined;
  readSession(workspacePath: string, sessionId: string): Promise<readonly UiPart[] | undefined>;
  openSession(workspacePath: string, sessionId: string): Promise<void>;
  createSession(workspacePath: string): Promise<void>;
  sendSessionMessage(workspacePath: string, sessionId: string, text: string, delivery: "prompt" | "follow-up" | "steer"): Promise<void>;
  abortSession(workspacePath: string, sessionId: string): Promise<void>;
  renameSession(workspacePath: string, sessionId: string, title: string): Promise<void>;
  setSessionArchived(workspacePath: string, sessionId: string, archived: boolean): Promise<void>;
  setSessionModel(workspacePath: string, sessionId: string, provider: string, modelId: string): Promise<void>;
  customizationState(): CustomizationState | undefined;
  plugins(): readonly PluginStatus[];
  getPluginAuthoringReference(): Promise<string>;
  listPluginFiles(): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  createPlugin(input: { pluginId: string; name: string; renderer: boolean; backend: boolean; scene: boolean; expectedWorkingRevision: string }): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  readPluginFile(pluginId: string, path: string): Promise<string>;
  writePluginFile(pluginId: string, path: string, content: string, expectedWorkingRevision: string): Promise<{ workingRevision: string; buildRevision: string; files: string[] }>;
  validateCustomization(expectedBaseRevision: string | undefined, request: string, expectedSourceRevision?: string): Promise<{ revision: string; sourceRevision: string; diagnostics: PluginDiagnostic[]; valid: boolean }>;
  activateCustomization(revision: string, expectedSourceRevision: string, request: string): Promise<{ revision: string; activating: true }>;
  rollbackCustomization(): Promise<CustomizationState>;
  useFactoryCustomization(): Promise<CustomizationState>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<readonly PluginStatus[]>;
  setActiveScene(pluginId?: string): Promise<readonly PluginStatus[]>;
}

export interface AppControlSession {
  workspacePath: string;
  workspaceName: string;
  sessionId: string;
  title: string;
  modified: string;
  messageCount: number;
  archived: boolean;
  activity?: "running" | "unread";
}

export interface AppControlState {
  currentSession?: { workspacePath: string; sessionId: string };
  projectCount: number;
  sessionCount: number;
  projects: Array<{ path: string; name: string; sessionCount: number }>;
  attentionSessions: AppControlSession[];
  recentSessions: AppControlSession[];
}

export interface AppControlReadablePart {
  index: number;
  id: string;
  entryId?: string;
  kind: UiPart["kind"];
  role?: "user" | "assistant";
  text: string;
}

export interface AppControlSearchMatch {
  session: AppControlSession;
  matches: Array<{ location: "title" | "transcript"; partIndex?: number; snippet: string }>;
}

export type AppControlResult =
  | { ok: true; name: "get_app_state"; state: AppControlState }
  | { ok: true; name: "get_customization_state"; state?: CustomizationState; plugins: readonly PluginStatus[] }
  | { ok: true; name: "get_plugin_authoring_reference"; reference: string }
  | { ok: true; name: "list_plugin_files" | "create_plugin" | "write_plugin_file"; workingRevision: string; buildRevision: string; files: string[] }
  | { ok: true; name: "read_plugin_file"; pluginId: string; path: string; content: string }
  | { ok: true; name: "validate_customization"; revision: string; sourceRevision: string; diagnostics: PluginDiagnostic[]; valid: boolean }
  | { ok: true; name: "activate_customization"; revision: string; activating: true }
  | { ok: true; name: "rollback_customization" | "use_factory_customization"; state: CustomizationState }
  | { ok: true; name: "set_plugin_enabled" | "set_active_scene"; plugins: readonly PluginStatus[] }
  | { ok: true; name: "get_session_status"; session: AppControlSession; selected: boolean; status: "running" | "unread" | "idle" }
  | { ok: true; name: "open_session"; opened: SessionTarget }
  | { ok: true; name: "list_sessions"; sessions: AppControlSession[]; total: number; nextCursor?: number }
  | { ok: true; name: "read_session"; session: AppControlSession; parts: AppControlReadablePart[]; totalParts: number; nextCursor?: number }
  | { ok: true; name: "search_sessions"; query: string; results: AppControlSearchMatch[]; searchedSessions: number }
  | { ok: true; name: "create_session"; workspacePath: string; status: "creating" }
  | { ok: true; name: "send_session_message"; target: SessionTarget; delivery: "prompt" | "follow-up" | "steer"; status: "sent" }
  | { ok: true; name: "abort_session"; target: SessionTarget; status: "stopping" }
  | { ok: true; name: "rename_session"; target: SessionTarget; title: string }
  | { ok: true; name: "set_session_archived"; target: SessionTarget; archived: boolean }
  | { ok: true; name: "set_session_model"; target: SessionTarget; provider: string; modelId: string; status: "changing" }
  | { ok: false; name: AppControlInvocation["name"]; error: string };

interface SessionTarget { workspacePath: string; sessionId: string }

const recentSessionLimit = 20;

export class AppControlBridge {
  constructor(private readonly host: AppControlHost) {}

  listTools() {
    return appControlToolCatalog.map((tool) => ({
      ...tool,
      parameters: jsonObjectSchema.parse(tool.parameters),
    }));
  }

  getAppState(): AppControlState {
    const sessions = this.sortedSessions();
    const state = {
      projectCount: this.host.projects().length,
      sessionCount: sessions.length,
      projects: this.host.projects().map((project) => ({
        path: project.path,
        name: project.name,
        sessionCount: sessions.filter((session) => session.workspacePath === project.path).length
      })),
      attentionSessions: sessions.filter((session) => this.host.sessionActivity(session.workspacePath, session.id)).map((session) => this.toControlSession(session)),
      recentSessions: sessions.slice(0, recentSessionLimit).map((session) => this.toControlSession(session))
    };
    const currentSession = this.host.currentSession();
    return currentSession ? { ...state, currentSession } : state;
  }

  async invoke(untrustedInput: unknown): Promise<AppControlResult> {
    const invocation = appControlInvocationSchema.parse(untrustedInput);
    if (invocation.name === "get_app_state") return { ok: true, name: invocation.name, state: this.getAppState() };
    if (invocation.name === "get_customization_state") {
      const state = this.host.customizationState();
      const result = {
        ok: true,
        name: invocation.name,
        plugins: toStrictJson(pluginStatusesSchema.parse(this.host.plugins()))
      } as const;
      return state === undefined ? result : { ...result, state: toStrictJson(customizationStateSchema.parse(state)) };
    }
    if (invocation.name === "get_plugin_authoring_reference") return { ok: true, name: invocation.name, reference: await this.host.getPluginAuthoringReference() };
    if (invocation.name === "list_plugin_files") return { ok: true, name: invocation.name, ...await this.host.listPluginFiles() };
    if (invocation.name === "create_plugin") return { ok: true, name: invocation.name, ...await this.host.createPlugin(invocation.arguments) };
    if (invocation.name === "read_plugin_file") return { ok: true, name: invocation.name, pluginId: invocation.arguments.pluginId, path: invocation.arguments.path, content: await this.host.readPluginFile(invocation.arguments.pluginId, invocation.arguments.path) };
    if (invocation.name === "write_plugin_file") return { ok: true, name: invocation.name, ...await this.host.writePluginFile(invocation.arguments.pluginId, invocation.arguments.path, invocation.arguments.content, invocation.arguments.expectedWorkingRevision) };
    if (invocation.name === "validate_customization") return { ok: true, name: invocation.name, ...await this.host.validateCustomization(invocation.arguments.expectedBaseRevision, invocation.arguments.request, invocation.arguments.expectedSourceRevision) };
    if (invocation.name === "activate_customization") return { ok: true, name: invocation.name, ...await this.host.activateCustomization(invocation.arguments.revision, invocation.arguments.expectedSourceRevision, invocation.arguments.request) };
    if (invocation.name === "rollback_customization") return { ok: true, name: invocation.name, state: toStrictJson(customizationStateSchema.parse(await this.host.rollbackCustomization())) };
    if (invocation.name === "use_factory_customization") return { ok: true, name: invocation.name, state: toStrictJson(customizationStateSchema.parse(await this.host.useFactoryCustomization())) };
    if (invocation.name === "set_plugin_enabled") return { ok: true, name: invocation.name, plugins: toStrictJson(pluginStatusesSchema.parse(await this.host.setPluginEnabled(invocation.arguments.pluginId, invocation.arguments.enabled))) };
    if (invocation.name === "set_active_scene") return { ok: true, name: invocation.name, plugins: toStrictJson(pluginStatusesSchema.parse(await this.host.setActiveScene(invocation.arguments.pluginId))) };
    if (invocation.name === "list_sessions") return this.listSessions(invocation.arguments);
    if (invocation.name === "search_sessions") return this.searchSessions(invocation.arguments);
    if (invocation.name === "create_session") return this.createSession(invocation.arguments.workspacePath);

    const { workspacePath, sessionId } = invocation.arguments;
    const known = this.knownSession(workspacePath, sessionId);
    if (!known) return { ok: false, name: invocation.name, error: "Cake could not find that session." };
    const target = { workspacePath, sessionId };

    if (invocation.name === "get_session_status") {
      const activity = this.host.sessionActivity(workspacePath, sessionId);
      const current = this.host.currentSession();
      return {
        ok: true,
        name: invocation.name,
        session: this.toControlSession(known),
        selected: current?.workspacePath === workspacePath && current.sessionId === sessionId,
        status: activity ?? "idle"
      };
    }
    if (invocation.name === "read_session") return this.readSession(known, invocation.arguments);
    if (invocation.name === "open_session") {
      await this.host.openSession(workspacePath, sessionId);
      return { ok: true, name: invocation.name, opened: target };
    }
    if (invocation.name === "send_session_message") {
      const delivery = invocation.arguments.delivery ?? (this.host.sessionActivity(workspacePath, sessionId) === "running" ? "follow-up" : "prompt");
      await this.host.sendSessionMessage(workspacePath, sessionId, invocation.arguments.text, delivery);
      return { ok: true, name: invocation.name, target, delivery, status: "sent" };
    }
    if (invocation.name === "abort_session") {
      if (this.host.sessionActivity(workspacePath, sessionId) !== "running") {
        return { ok: false, name: invocation.name, error: "That session is not currently running." };
      }
      await this.host.abortSession(workspacePath, sessionId);
      return { ok: true, name: invocation.name, target, status: "stopping" };
    }
    if (invocation.name === "rename_session") {
      await this.host.renameSession(workspacePath, sessionId, invocation.arguments.title);
      return { ok: true, name: invocation.name, target, title: invocation.arguments.title };
    }
    if (invocation.name === "set_session_archived") {
      await this.host.setSessionArchived(workspacePath, sessionId, invocation.arguments.archived);
      return { ok: true, name: invocation.name, target, archived: invocation.arguments.archived };
    }
    await this.host.setSessionModel(workspacePath, sessionId, invocation.arguments.provider, invocation.arguments.modelId);
    return { ok: true, name: invocation.name, target, provider: invocation.arguments.provider, modelId: invocation.arguments.modelId, status: "changing" };
  }

  private sortedSessions() {
    return [...this.host.sessions()].sort((left, right) => right.modified.localeCompare(left.modified));
  }

  private knownSession(workspacePath: string, sessionId: string) {
    return this.host.sessions().find((session) => session.workspacePath === workspacePath && session.id === sessionId);
  }

  private listSessions({ workspacePath, includeArchived, cursor, limit }: z.infer<typeof sessionPageSchema>): AppControlResult {
    const matching = this.sortedSessions().filter((session) => (!workspacePath || session.workspacePath === workspacePath) && (includeArchived || !session.archived));
    const sessions = matching.slice(cursor, cursor + limit).map((session) => this.toControlSession(session));
    const nextCursor = cursor + sessions.length < matching.length ? cursor + sessions.length : undefined;
    const result = { ok: true, name: "list_sessions", sessions, total: matching.length } as const;
    return nextCursor === undefined ? result : { ...result, nextCursor };
  }

  private async readSession(known: GlobalSessionSummary, { workspacePath, sessionId, cursor, limit }: z.infer<typeof sessionReadSchema>): Promise<AppControlResult> {
    const parts = await this.host.readSession(workspacePath, sessionId);
    if (!parts) return { ok: false, name: "read_session", error: "Cake could not read that session." };
    const page = parts.slice(cursor, cursor + limit).map((part, offset) => this.toReadablePart(part, cursor + offset));
    const nextCursor = cursor + page.length < parts.length ? cursor + page.length : undefined;
    const result = {
      ok: true,
      name: "read_session",
      session: this.toControlSession(known),
      parts: page,
      totalParts: parts.length,
    } as const;
    return nextCursor === undefined ? result : { ...result, nextCursor };
  }

  private async searchSessions({ query, workspacePath, includeArchived, limit }: z.infer<typeof searchSessionsSchema>): Promise<AppControlResult> {
    const candidates = this.sortedSessions().filter((session) => (!workspacePath || session.workspacePath === workspacePath) && (includeArchived || !session.archived));
    const needle = query.toLocaleLowerCase();
    const results: AppControlSearchMatch[] = [];
    let searchedSessions = 0;
    for (const session of candidates) {
      searchedSessions += 1;
      const matches: AppControlSearchMatch["matches"] = [];
      const titleIndex = session.title.toLocaleLowerCase().indexOf(needle);
      if (titleIndex >= 0) matches.push({ location: "title", snippet: matchingSnippet(session.title, titleIndex, query.length) });
      const parts = await this.host.readSession(session.workspacePath, session.id);
      for (let index = 0; index < (parts?.length ?? 0) && matches.length < 3; index += 1) {
        const part = parts?.[index];
        if (!part) continue;
        const text = this.toReadablePart(part, index).text;
        const matchIndex = text.toLocaleLowerCase().indexOf(needle);
        if (matchIndex >= 0) matches.push({ location: "transcript", partIndex: index, snippet: matchingSnippet(text, matchIndex, query.length) });
      }
      if (matches.length > 0) results.push({ session: this.toControlSession(session), matches });
      if (results.length >= limit) break;
    }
    return { ok: true, name: "search_sessions", query, results, searchedSessions };
  }

  private async createSession(workspacePath: string): Promise<AppControlResult> {
    if (!this.host.projects().some((project) => project.path === workspacePath)) {
      return { ok: false, name: "create_session", error: "Cake could not find that project." };
    }
    await this.host.createSession(workspacePath);
    return { ok: true, name: "create_session", workspacePath, status: "creating" };
  }

  private toControlSession(session: GlobalSessionSummary): AppControlSession {
    const activity = this.host.sessionActivity(session.workspacePath, session.id);
    const result = {
      workspacePath: session.workspacePath,
      workspaceName: session.workspaceName,
      sessionId: session.id,
      title: session.title,
      modified: session.modified,
      messageCount: session.messageCount,
      archived: session.archived,
    };
    return activity ? { ...result, activity } : result;
  }

  private toReadablePart(part: UiPart, index: number): AppControlReadablePart {
    const base = { index, id: part.id, kind: part.kind };
    if (part.kind === "text") {
      const result = { ...base, role: part.role, text: clip(part.text) };
      return part.entryId === undefined ? result : { ...result, entryId: part.entryId };
    }
    if (part.kind === "reasoning") return { ...base, text: clip(part.text) };
    if (part.kind === "tool") return { ...base, text: clip([`Tool: ${part.name}`, part.input, part.output].filter(Boolean).join("\n")) };
    if (part.kind === "source") return { ...base, text: clip(`${part.title}\n${part.url}`) };
    if (part.kind === "attachment") return { ...base, text: clip(`Attachment: ${part.name} (${part.mediaType})`) };
    if (part.kind === "notice") return { ...base, text: clip([part.title, part.detail].filter(Boolean).join("\n")) };
    if (part.kind === "compaction") return { ...base, text: clip(`Context compacted after ${part.tokensBefore} tokens\n${part.summary}`) };
    return { ...base, text: clip(`Review run: ${part.commentCount} comments (${part.status})`) };
  }
}

function tool(name: AppControlInvocation["name"], description: string, argumentsSchema: z.ZodType) {
  return {
    name,
    description,
    parameters: z.toJSONSchema(argumentsSchema, { io: "input", target: "draft-7" })
  } as const;
}

function matchingSnippet(value: string, index: number, matchLength: number) {
  const start = Math.max(0, index - 100);
  const end = Math.min(value.length, index + matchLength + 180);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}

function clip(value: string, limit = 4_000) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function toStrictJson<T>(value: T): T {
  // SAFETY: callers pass schema-validated JSON-shaped data; the round trip only removes properties whose value is undefined.
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value))) as T;
}
