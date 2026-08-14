import { z } from "zod";
import type { GlobalSessionSummary, ProjectRecord, UiPart } from "../ipc/session-contract";

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

export const appControlInvocationSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("get_app_state"), arguments: z.object({}).strict() }),
  z.object({ name: z.literal("get_session_status"), arguments: sessionTargetSchema }),
  z.object({ name: z.literal("open_session"), arguments: sessionTargetSchema }),
  z.object({ name: z.literal("list_sessions"), arguments: sessionPageSchema }),
  z.object({ name: z.literal("read_session"), arguments: sessionReadSchema }),
  z.object({ name: z.literal("search_sessions"), arguments: searchSessionsSchema }),
  z.object({
    name: z.literal("create_session"),
    arguments: z.object({ workspacePath: z.string().min(1).max(4_096) })
  }),
  z.object({
    name: z.literal("send_session_message"),
    arguments: sessionTargetSchema.extend({
      text: z.string().trim().min(1).max(100_000),
      delivery: z.enum(["prompt", "follow-up", "steer"]).optional()
    })
  }),
  z.object({ name: z.literal("abort_session"), arguments: sessionTargetSchema }),
  z.object({
    name: z.literal("rename_session"),
    arguments: sessionTargetSchema.extend({ title: z.string().trim().min(1).max(500) })
  }),
  z.object({
    name: z.literal("set_session_archived"),
    arguments: sessionTargetSchema.extend({ archived: z.boolean() })
  }),
  z.object({
    name: z.literal("set_session_model"),
    arguments: sessionTargetSchema.extend({
      provider: z.string().trim().min(1).max(100),
      modelId: z.string().trim().min(1).max(200)
    })
  })
]);

export type AppControlInvocation = z.infer<typeof appControlInvocationSchema>;

const targetProperties = {
  workspacePath: { type: "string", description: "Exact workspace path returned by Cake." },
  sessionId: { type: "string", description: "Exact session ID returned by Cake." }
} as const;

export const appControlToolCatalog = [
  tool("get_app_state", "Read Cake's current selection and a compact summary of projects and recent or active sessions.", {}),
  tool("get_session_status", "Inspect whether a known session is selected, running, unread, or idle.", targetProperties, ["workspacePath", "sessionId"]),
  tool("open_session", "Open a known Cake session in its project.", targetProperties, ["workspacePath", "sessionId"]),
  tool("list_sessions", "List Cake sessions by recency, optionally limited to one project or including archived sessions.", {
    workspacePath: { type: "string", description: "Optional exact workspace path." },
    includeArchived: { type: "boolean", default: false },
    cursor: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 100 }
  }),
  tool("read_session", "Read a bounded page of displayable parts from a known Cake session without opening it.", {
    ...targetProperties,
    cursor: { type: "integer", minimum: 0, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
  }, ["workspacePath", "sessionId"]),
  tool("search_sessions", "Search session titles and transcript contents without opening sessions.", {
    query: { type: "string", description: "Words or phrase to find." },
    workspacePath: { type: "string", description: "Optional exact workspace path." },
    includeArchived: { type: "boolean", default: false },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }
  }, ["query"]),
  tool("create_session", "Start a new session in a known Cake project and open it.", {
    workspacePath: { type: "string", description: "Exact project path returned by Cake." }
  }, ["workspacePath"]),
  tool("send_session_message", "Send an instruction to a known session without opening it. Use only when the user explicitly asks to send or delegate work.", {
    ...targetProperties,
    text: { type: "string", description: "The exact instruction to send." },
    delivery: { type: "string", enum: ["prompt", "follow-up", "steer"], description: "Optional delivery policy. Cake chooses prompt or follow-up when omitted." }
  }, ["workspacePath", "sessionId", "text"]),
  tool("abort_session", "Stop a known session that is currently running.", targetProperties, ["workspacePath", "sessionId"]),
  tool("rename_session", "Rename a known session.", {
    ...targetProperties,
    title: { type: "string", description: "New session title." }
  }, ["workspacePath", "sessionId", "title"]),
  tool("set_session_archived", "Archive or restore a known session.", {
    ...targetProperties,
    archived: { type: "boolean" }
  }, ["workspacePath", "sessionId", "archived"]),
  tool("set_session_model", "Change the model for one known session. Use provider and model IDs returned by Cake settings.", {
    ...targetProperties,
    provider: { type: "string" },
    modelId: { type: "string" }
  }, ["workspacePath", "sessionId", "provider", "modelId"])
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

  listTools() { return appControlToolCatalog; }

  getAppState(): AppControlState {
    const sessions = this.sortedSessions();
    return {
      currentSession: this.host.currentSession(),
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
  }

  async invoke(input: unknown): Promise<AppControlResult> {
    const invocation = appControlInvocationSchema.parse(input);
    if (invocation.name === "get_app_state") return { ok: true, name: invocation.name, state: this.getAppState() };
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
    return { ok: true, name: "list_sessions", sessions, total: matching.length, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  private async readSession(known: GlobalSessionSummary, { workspacePath, sessionId, cursor, limit }: z.infer<typeof sessionReadSchema>): Promise<AppControlResult> {
    const parts = await this.host.readSession(workspacePath, sessionId);
    if (!parts) return { ok: false, name: "read_session", error: "Cake could not read that session." };
    const page = parts.slice(cursor, cursor + limit).map((part, offset) => this.toReadablePart(part, cursor + offset));
    const nextCursor = cursor + page.length < parts.length ? cursor + page.length : undefined;
    return {
      ok: true,
      name: "read_session",
      session: this.toControlSession(known),
      parts: page,
      totalParts: parts.length,
      ...(nextCursor === undefined ? {} : { nextCursor })
    };
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
    return {
      workspacePath: session.workspacePath,
      workspaceName: session.workspaceName,
      sessionId: session.id,
      title: session.title,
      modified: session.modified,
      messageCount: session.messageCount,
      archived: session.archived,
      ...(activity ? { activity } : {})
    };
  }

  private toReadablePart(part: UiPart, index: number): AppControlReadablePart {
    const base = { index, id: part.id, kind: part.kind };
    if (part.kind === "text") return { ...base, entryId: part.entryId, role: part.role, text: clip(part.text) };
    if (part.kind === "reasoning") return { ...base, text: clip(part.text) };
    if (part.kind === "tool") return { ...base, text: clip([`Tool: ${part.name}`, part.input, part.output].filter(Boolean).join("\n")) };
    if (part.kind === "source") return { ...base, text: clip(`${part.title}\n${part.url}`) };
    if (part.kind === "attachment") return { ...base, text: clip(`Attachment: ${part.name} (${part.mediaType})`) };
    if (part.kind === "notice") return { ...base, text: clip([part.title, part.detail].filter(Boolean).join("\n")) };
    return { ...base, text: clip(`Review run: ${part.commentCount} comments (${part.status})`) };
  }
}

function tool(name: string, description: string, properties: Record<string, unknown>, required?: readonly string[]) {
  return {
    name,
    description,
    parameters: { type: "object", properties, ...(required ? { required } : {}), additionalProperties: false }
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
