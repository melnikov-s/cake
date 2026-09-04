import { Effect, Schema } from "effect";
import { jsonObjectSchema, jsonValueSchema, type JsonValue } from "../ipc/json-contract";
import {
  thinkingLevelSchema,
  type ChatConfiguration,
  type ProjectRecord,
} from "../ipc/session-contract";
import type { CakeChatSummary } from "../domain/cake-chat-data";
import type { SessionSummary } from "./models/SessionSummary";
import type { WorktreeRecord } from "../ipc/worktree-contract";
import type { ScheduledMessage } from "../domain/scheduled-message-data";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const trimmed = (minimum: number, maximum: number) =>
  Schema.Trim.pipe(Schema.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum)));
const sessionIdTargetSchema = Schema.Struct({ sessionId: bounded(1, 256) });
const sessionNavigationTargetSchema = Schema.Struct({
  ...sessionIdTargetSchema.fields,
  messageId: Schema.optionalKey(bounded(1, 256)),
});
const emptyArgumentsSchema = Schema.Struct({});
const appControlArgumentSchemas = {
  get_app_state: emptyArgumentsSchema,
  get_session_status: sessionIdTargetSchema,
  open_session: sessionNavigationTargetSchema,
  create_session: Schema.Struct({
    workspacePath: bounded(1, 4_096),
    name: trimmed(1, 500),
    initialPrompt: trimmed(1, 100_000),
    model: Schema.optionalKey(
      Schema.Struct({
        provider: trimmed(1, 256),
        modelId: trimmed(1, 512),
        thinkingLevel: thinkingLevelSchema.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("off" as const)),
        ),
        fastMode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      }),
    ),
    worktreeName: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
    ),
    markdown: Schema.optionalKey(Schema.Boolean),
  }),
  create_draft_session: Schema.Struct({
    workspacePath: bounded(1, 4_096),
    name: trimmed(1, 500),
    initialPrompt: trimmed(1, 100_000),
    model: Schema.optionalKey(
      Schema.Struct({
        provider: trimmed(1, 256),
        modelId: trimmed(1, 512),
        thinkingLevel: thinkingLevelSchema.pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("off" as const)),
        ),
        fastMode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      }),
    ),
  }),
  send_session_message: Schema.Struct({
    ...sessionIdTargetSchema.fields,
    text: trimmed(1, 100_000),
    delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
  }),
  compact_session: Schema.Struct({
    ...sessionIdTargetSchema.fields,
    instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
  }),
  schedule_session_message: Schema.Struct({
    ...sessionIdTargetSchema.fields,
    text: trimmed(1, 100_000),
    sendAt: bounded(1, 64),
  }),
  list_scheduled_messages: Schema.Struct({
    sessionId: Schema.optionalKey(bounded(1, 256)),
  }),
  cancel_scheduled_message: Schema.Struct({ id: bounded(1, 256) }),
  abort_session: sessionIdTargetSchema,
  rename_session: Schema.Struct({ ...sessionIdTargetSchema.fields, title: trimmed(1, 500) }),
  set_session_resolved: Schema.Struct({
    ...sessionIdTargetSchema.fields,
    resolved: Schema.Boolean,
  }),
  set_sessions_resolved: Schema.Struct({
    sessionIds: Schema.Array(bounded(1, 256)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(10_000),
    ),
    resolved: Schema.Boolean,
  }),
  set_cake_chat_sessions_resolved: Schema.Struct({
    sessionIds: Schema.Array(bounded(1, 256)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(10_000),
    ),
    resolved: Schema.Boolean,
  }),
  set_session_model: Schema.Struct({
    ...sessionIdTargetSchema.fields,
    provider: trimmed(1, 100),
    modelId: trimmed(1, 200),
  }),
} as const;

function invocation<Name extends keyof typeof appControlArgumentSchemas>(name: Name) {
  return Schema.Struct({ name: Schema.Literal(name), arguments: appControlArgumentSchemas[name] });
}

const appControlInvocationSchema = Schema.Union([
  invocation("get_app_state"),
  invocation("get_session_status"),
  invocation("open_session"),
  invocation("create_session"),
  invocation("create_draft_session"),
  invocation("send_session_message"),
  invocation("compact_session"),
  invocation("schedule_session_message"),
  invocation("list_scheduled_messages"),
  invocation("cancel_scheduled_message"),
  invocation("abort_session"),
  invocation("rename_session"),
  invocation("set_session_resolved"),
  invocation("set_sessions_resolved"),
  invocation("set_cake_chat_sessions_resolved"),
  invocation("set_session_model"),
]);

type AppControlInvocation = typeof appControlInvocationSchema.Type;
type SessionSummaryView = Pick<
  SessionSummary,
  | "workingDirectory"
  | "projectName"
  | "sessionId"
  | "title"
  | "modifiedAt"
  | "messageCount"
  | "resolved"
  | "draft"
> & { managedWorktree?: SessionSummary["managedWorktree"] };

export interface AppControlHost {
  currentSession(): { workspacePath: string; sessionId: string } | undefined;
  projects(): readonly ProjectRecord[];
  sessions(): readonly SessionSummaryView[];
  cakeChatSessions(): readonly CakeChatSummary[];
  sessionActivity(sessionId: string): "running" | "unread" | "error" | undefined;
  openSession(sessionId: string, messageId?: string): Promise<boolean | void>;
  createSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
    worktreeName?: string;
  }): Promise<{ workspacePath: string; sessionId: string; managedWorktree?: WorktreeRecord }>;
  createDraftSession(input: {
    workspacePath: string;
    name: string;
    initialPrompt: string;
    model?: ChatConfiguration;
  }): Promise<{ workspacePath: string; sessionId: string }>;
  sendSessionMessage(
    sessionId: string,
    text: string,
    delivery: "prompt" | "follow-up" | "steer",
  ): Promise<void>;
  compactSession(sessionId: string, instructions?: string): Promise<void>;
  scheduleSessionMessage(input: {
    targetSessionId: string;
    text: string;
    sendAt: string;
  }): Promise<ScheduledMessage>;
  listScheduledMessages(sessionId?: string): Promise<readonly ScheduledMessage[]>;
  cancelScheduledMessage(id: string): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
  setSessionResolved(sessionId: string, resolved: boolean): Promise<void>;
  setSessionsResolved(sessionIds: readonly string[], resolved: boolean): Promise<number>;
  setCakeChatSessionsResolved(sessionIds: readonly string[], resolved: boolean): Promise<number>;
  setSessionModel(sessionId: string, provider: string, modelId: string): Promise<void>;
}

export interface AppControlSession {
  workspacePath: string;
  workspaceName: string;
  sessionId: string;
  title: string;
  modified: string;
  messageCount: number;
  resolved: boolean;
  draft: boolean;
  managedWorktree?: SessionSummaryView["managedWorktree"];
  activity?: "running" | "unread" | "error";
}

export interface AppControlState {
  currentSession?: { workspacePath: string; sessionId: string };
  projectCount: number;
  sessionCount: number;
  projects: Array<{ path: string; name: string; sessionCount: number }>;
  attentionSessions: AppControlSession[];
  recentSessions: AppControlSession[];
}

export type AppControlResult =
  | { ok: true; name: "get_app_state"; state: AppControlState }
  | {
      ok: true;
      name: "get_session_status";
      session: AppControlSession;
      selected: boolean;
      status: "running" | "unread" | "error" | "idle";
    }
  | { ok: true; name: "open_session"; opened: SessionTarget & { messageId?: string } }
  | {
      ok: true;
      name: "create_session";
      workspacePath: string;
      sessionId: string;
      status: "started";
      managedWorktree?: WorktreeRecord;
    }
  | {
      ok: true;
      name: "create_draft_session";
      workspacePath: string;
      sessionId: string;
      status: "saved-draft";
    }
  | {
      ok: true;
      name: "send_session_message";
      target: SessionTarget;
      delivery: "prompt" | "queue" | "steer";
      status: "sent";
    }
  | { ok: true; name: "compact_session"; target: SessionTarget; status: "compacted" }
  | {
      ok: true;
      name: "schedule_session_message";
      target: SessionTarget;
      scheduledMessage: ScheduledMessage;
      status: "scheduled";
    }
  | { ok: true; name: "list_scheduled_messages"; messages: readonly ScheduledMessage[] }
  | { ok: true; name: "cancel_scheduled_message"; id: string; status: "cancelled" }
  | { ok: true; name: "abort_session"; target: SessionTarget; status: "stopping" }
  | { ok: true; name: "rename_session"; target: SessionTarget; title: string }
  | { ok: true; name: "set_session_resolved"; target: SessionTarget; resolved: boolean }
  | {
      ok: true;
      name: "set_sessions_resolved";
      sessionIds: string[];
      resolved: boolean;
      sessionCount: number;
    }
  | {
      ok: true;
      name: "set_cake_chat_sessions_resolved";
      sessionIds: string[];
      resolved: boolean;
      sessionCount: number;
    }
  | {
      ok: true;
      name: "set_session_model";
      target: SessionTarget;
      provider: string;
      modelId: string;
      status: "changing";
    }
  | {
      ok: true;
      command: "sessions.list";
      name: "sessions.list";
      sessions: AppControlSession[];
      attentionSessions: AppControlSession[];
    }
  | {
      ok: true;
      command: "sessions.resolve";
      name: "sessions.resolve";
      targets: ReadonlyArray<{ kind: "project" | "cake-chat"; sessionId: string }>;
      resolved: boolean;
      sessionCount: number;
    }
  | { ok: false; name: AppControlInvocation["name"]; error: string };

interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

const sessionResolutionSchema = Schema.Struct({
  targets: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["project", "cake-chat"]),
      sessionId: bounded(1, 256),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
  resolved: Schema.Boolean,
});

const modelControlOperations = [
  operation(
    "app.state",
    "app",
    "Inspect Cake's current selection and project and session summaries.",
    appControlArgumentSchemas.get_app_state,
  ),
  operation(
    "sessions.list",
    "sessions",
    "List all project sessions, ordered by recency, and attention-worthy project sessions.",
    emptyArgumentsSchema,
  ),
  operation(
    "sessions.info",
    "sessions",
    "Inspect one explicitly targeted project session.",
    appControlArgumentSchemas.get_session_status,
  ),
  operation(
    "sessions.open",
    "sessions",
    "Open one explicitly targeted project session, optionally at a specific transcript message.",
    appControlArgumentSchemas.open_session,
  ),
  operation(
    "sessions.create",
    "sessions",
    "Create, configure, name, open, and send the initial prompt to a project session, optionally with an exact model or in a new managed worktree.",
    appControlArgumentSchemas.create_session,
  ),
  operation(
    "sessions.create-draft",
    "sessions",
    "Create, configure, name, open, and save an initial prompt as a Cake-owned draft without starting a Pi session.",
    appControlArgumentSchemas.create_draft_session,
  ),
  operation(
    "sessions.send",
    "sessions",
    "Send, queue, or steer a message to one explicitly targeted session without opening it.",
    appControlArgumentSchemas.send_session_message,
  ),
  operation(
    "sessions.compact",
    "sessions",
    "Compact one explicitly targeted Project Session through Pi's normal compaction mechanism.",
    appControlArgumentSchemas.compact_session,
  ),
  operation(
    "sessions.schedule",
    "sessions",
    "Schedule a message for one explicitly targeted Project Session at an ISO timestamp.",
    appControlArgumentSchemas.schedule_session_message,
  ),
  operation(
    "sessions.scheduled",
    "sessions",
    "List scheduled messages, optionally filtered to one Project Session.",
    appControlArgumentSchemas.list_scheduled_messages,
  ),
  operation(
    "sessions.cancel-scheduled",
    "sessions",
    "Cancel one scheduled message by its ID.",
    appControlArgumentSchemas.cancel_scheduled_message,
  ),
  operation(
    "sessions.abort",
    "sessions",
    "Stop one explicitly targeted running session.",
    appControlArgumentSchemas.abort_session,
  ),
  operation(
    "sessions.resolve",
    "sessions",
    "Idempotently resolve or restore explicit project or Cake Chat targets.",
    sessionResolutionSchema,
  ),
] as const;

const commandToLegacyName = {
  "app.state": "get_app_state",
  "sessions.info": "get_session_status",
  "sessions.open": "open_session",
  "sessions.create": "create_session",
  "sessions.create-draft": "create_draft_session",
  "sessions.send": "send_session_message",
  "sessions.compact": "compact_session",
  "sessions.schedule": "schedule_session_message",
  "sessions.scheduled": "list_scheduled_messages",
  "sessions.cancel-scheduled": "cancel_scheduled_message",
  "sessions.abort": "abort_session",
} as const;

function operation(command: string, topic: string, summary: string, schema: Schema.Constraint) {
  const definition = {
    command,
    topic,
    summary,
    parameters: Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({
      target: "draft-07",
    }),
    examples: [],
    result: "A bounded authoritative Cake application result.",
  };
  return definition;
}

export function listAppControlTools() {
  return modelControlOperations.map((definition) => ({
    ...definition,
    parameters: Schema.decodeUnknownSync(jsonObjectSchema)(definition.parameters),
  }));
}

export class AppControlBridge {
  constructor(private readonly host: AppControlHost) {}

  listTools() {
    return listAppControlTools();
  }

  getAppState(): AppControlState {
    const sessions = this.sortedSessions();
    const state = {
      projectCount: this.host.projects().length,
      sessionCount: sessions.length,
      projects: this.host.projects().map((project) => ({
        path: project.path,
        name: project.name,
        sessionCount: sessions.filter((session) => session.workingDirectory === project.path)
          .length,
      })),
      attentionSessions: sessions
        .filter((session) => this.host.sessionActivity(session.sessionId))
        .map((session) => this.toControlSession(session)),
      recentSessions: sessions.map((session) => this.toControlSession(session)),
    };
    const currentSession = this.host.currentSession();
    return currentSession ? { ...state, currentSession } : state;
  }

  async invoke(untrustedInput: unknown): Promise<JsonValue> {
    return toJsonValue(await this.invokeResult(untrustedInput));
  }

  private async invokeResult(untrustedInput: unknown): Promise<AppControlResult> {
    const gatewayInvocation = Schema.decodeUnknownSync(
      Schema.Struct({ name: Schema.String, arguments: jsonObjectSchema }),
    )(untrustedInput);
    if (gatewayInvocation.name === "sessions.list") {
      const state = this.getAppState();
      return toStrictJson({
        ok: true,
        command: "sessions.list",
        name: "sessions.list",
        sessions: state.recentSessions,
        attentionSessions: state.attentionSessions,
      });
    }
    if (gatewayInvocation.name === "sessions.resolve") {
      const input = Schema.decodeUnknownSync(sessionResolutionSchema)(gatewayInvocation.arguments);
      const projectIds = input.targets
        .filter((target) => target.kind === "project")
        .map((target) => target.sessionId);
      const cakeChatIds = input.targets
        .filter((target) => target.kind === "cake-chat")
        .map((target) => target.sessionId);
      const unknownProject = projectIds.find((sessionId) => !this.knownSession(sessionId));
      if (unknownProject)
        return {
          ok: false,
          name: "set_sessions_resolved",
          error: `Cake could not find session ${unknownProject}.`,
        };
      const knownCakeChatIds = new Set(
        this.host.cakeChatSessions().map((session) => session.sessionId),
      );
      const unknownCakeChat = cakeChatIds.find((sessionId) => !knownCakeChatIds.has(sessionId));
      if (unknownCakeChat)
        return {
          ok: false,
          name: "set_cake_chat_sessions_resolved",
          error: `Cake could not find Cake Chat session ${unknownCakeChat}.`,
        };
      const [projectCount, cakeChatCount] = await Promise.all([
        projectIds.length
          ? this.host.setSessionsResolved([...new Set(projectIds)], input.resolved)
          : 0,
        cakeChatIds.length
          ? this.host.setCakeChatSessionsResolved([...new Set(cakeChatIds)], input.resolved)
          : 0,
      ]);
      return toStrictJson({
        ok: true,
        command: "sessions.resolve",
        name: "sessions.resolve",
        targets: input.targets,
        resolved: input.resolved,
        sessionCount: projectCount + cakeChatCount,
      });
    }
    const legacyName = Object.entries(commandToLegacyName).find(
      ([command]) => command === gatewayInvocation.name,
    )?.[1];
    const invocation = Schema.decodeUnknownSync(appControlInvocationSchema)(
      legacyName ? { name: legacyName, arguments: gatewayInvocation.arguments } : gatewayInvocation,
    );
    if (invocation.name === "get_app_state")
      return { ok: true, name: invocation.name, state: this.getAppState() };
    if (invocation.name === "create_session") return this.createSession(invocation.arguments);
    if (invocation.name === "create_draft_session")
      return this.createDraftSession(invocation.arguments);
    if (invocation.name === "set_sessions_resolved")
      return this.setSessionsResolved(invocation.arguments);
    if (invocation.name === "set_cake_chat_sessions_resolved")
      return this.setCakeChatSessionsResolved(invocation.arguments);
    if (invocation.name === "list_scheduled_messages") {
      if (invocation.arguments.sessionId && !this.knownSession(invocation.arguments.sessionId))
        return {
          ok: false,
          name: invocation.name,
          error: "Cake could not find that session.",
        };
      return {
        ok: true,
        name: invocation.name,
        messages: await this.host.listScheduledMessages(invocation.arguments.sessionId),
      };
    }
    if (invocation.name === "cancel_scheduled_message") {
      await this.host.cancelScheduledMessage(invocation.arguments.id);
      return {
        ok: true,
        name: invocation.name,
        id: invocation.arguments.id,
        status: "cancelled",
      };
    }

    const { sessionId } = invocation.arguments;
    const known = this.knownSession(sessionId);
    if (!known)
      return { ok: false, name: invocation.name, error: "Cake could not find that session." };
    const workspacePath = known.workingDirectory;
    const target = { workspacePath, sessionId };

    if (invocation.name === "get_session_status") {
      const activity = this.host.sessionActivity(sessionId);
      const current = this.host.currentSession();
      return {
        ok: true,
        name: invocation.name,
        session: this.toControlSession(known),
        selected: current?.workspacePath === workspacePath && current?.sessionId === sessionId,
        status: activity ?? "idle",
      };
    }
    if (invocation.name === "open_session") {
      const { messageId } = invocation.arguments;
      const messageFound = messageId
        ? await this.host.openSession(sessionId, messageId)
        : await this.host.openSession(sessionId);
      if (messageId && messageFound === false)
        return {
          ok: false,
          name: invocation.name,
          error: `Cake could not find message ${messageId} in that session.`,
        };
      return {
        ok: true,
        name: invocation.name,
        opened: messageId ? { ...target, messageId } : target,
      };
    }
    if (invocation.name === "send_session_message") {
      const delivery =
        invocation.arguments.delivery ??
        (this.host.sessionActivity(sessionId) === "running" ? "queue" : "prompt");
      await this.host.sendSessionMessage(
        sessionId,
        invocation.arguments.text,
        delivery === "queue" ? "follow-up" : delivery,
      );
      return { ok: true, name: invocation.name, target, delivery, status: "sent" };
    }
    if (invocation.name === "compact_session") {
      await this.host.compactSession(sessionId, invocation.arguments.instructions);
      return { ok: true, name: invocation.name, target, status: "compacted" };
    }
    if (invocation.name === "schedule_session_message") {
      const scheduledMessage = await this.host.scheduleSessionMessage({
        targetSessionId: sessionId,
        text: invocation.arguments.text,
        sendAt: invocation.arguments.sendAt,
      });
      return {
        ok: true,
        name: invocation.name,
        target,
        scheduledMessage,
        status: "scheduled",
      };
    }
    if (invocation.name === "abort_session") {
      if (this.host.sessionActivity(sessionId) !== "running") {
        return {
          ok: false,
          name: invocation.name,
          error: "That session is not currently running.",
        };
      }
      await this.host.abortSession(sessionId);
      return { ok: true, name: invocation.name, target, status: "stopping" };
    }
    if (invocation.name === "rename_session") {
      await this.host.renameSession(sessionId, invocation.arguments.title);
      return { ok: true, name: invocation.name, target, title: invocation.arguments.title };
    }
    if (invocation.name === "set_session_resolved") {
      await this.host.setSessionResolved(sessionId, invocation.arguments.resolved);
      return { ok: true, name: invocation.name, target, resolved: invocation.arguments.resolved };
    }
    await this.host.setSessionModel(
      sessionId,
      invocation.arguments.provider,
      invocation.arguments.modelId,
    );
    return {
      ok: true,
      name: invocation.name,
      target,
      provider: invocation.arguments.provider,
      modelId: invocation.arguments.modelId,
      status: "changing",
    };
  }

  private sortedSessions() {
    return [...this.host.sessions()].sort((left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt),
    );
  }

  private knownSession(sessionId: string) {
    return this.host.sessions().find((session) => session.sessionId === sessionId);
  }

  private async createSession(
    input: typeof appControlArgumentSchemas.create_session.Type,
  ): Promise<AppControlResult> {
    if (!this.host.projects().some((project) => project.path === input.workspacePath)) {
      return { ok: false, name: "create_session", error: "Cake could not find that project." };
    }
    const created = await this.host.createSession(input);
    const result: Extract<AppControlResult, { ok: true; name: "create_session" }> = {
      ok: true,
      name: "create_session",
      workspacePath: created.workspacePath,
      sessionId: created.sessionId,
      status: "started",
    };
    if (created.managedWorktree) result.managedWorktree = created.managedWorktree;
    return result;
  }

  private async createDraftSession(
    input: typeof appControlArgumentSchemas.create_draft_session.Type,
  ): Promise<AppControlResult> {
    if (!this.host.projects().some((project) => project.path === input.workspacePath)) {
      return {
        ok: false,
        name: "create_draft_session",
        error: "Cake could not find that project.",
      };
    }
    const created = await this.host.createDraftSession(input);
    return {
      ok: true,
      name: "create_draft_session",
      workspacePath: created.workspacePath,
      sessionId: created.sessionId,
      status: "saved-draft",
    };
  }

  private async setSessionsResolved({
    sessionIds,
    resolved,
  }: typeof appControlArgumentSchemas.set_sessions_resolved.Type): Promise<AppControlResult> {
    const unknown = sessionIds.find((sessionId) => !this.knownSession(sessionId));
    if (unknown)
      return {
        ok: false,
        name: "set_sessions_resolved",
        error: `Cake could not find session ${unknown}.`,
      };
    const uniqueSessionIds = [...new Set(sessionIds)];
    const sessionCount = await this.host.setSessionsResolved(uniqueSessionIds, resolved);
    return {
      ok: true,
      name: "set_sessions_resolved",
      sessionIds: uniqueSessionIds,
      resolved,
      sessionCount,
    };
  }

  private async setCakeChatSessionsResolved({
    sessionIds,
    resolved,
  }: typeof appControlArgumentSchemas.set_cake_chat_sessions_resolved.Type): Promise<AppControlResult> {
    const knownIds = new Set(this.host.cakeChatSessions().map((session) => session.sessionId));
    const unknown = sessionIds.find((sessionId) => !knownIds.has(sessionId));
    if (unknown)
      return {
        ok: false,
        name: "set_cake_chat_sessions_resolved",
        error: `Cake could not find Cake Chat session ${unknown}.`,
      };
    const uniqueSessionIds = [...new Set(sessionIds)];
    const sessionCount = await this.host.setCakeChatSessionsResolved(uniqueSessionIds, resolved);
    return {
      ok: true,
      name: "set_cake_chat_sessions_resolved",
      sessionIds: uniqueSessionIds,
      resolved,
      sessionCount,
    };
  }

  private toControlSession(session: SessionSummaryView): AppControlSession {
    const activity = this.host.sessionActivity(session.sessionId);
    const result = {
      workspacePath: session.workingDirectory,
      workspaceName: session.projectName,
      sessionId: session.sessionId,
      title: session.title,
      modified: session.modifiedAt,
      messageCount: session.messageCount,
      resolved: session.resolved,
      draft: session.draft,
    };
    const resultWithWorktree = session.managedWorktree
      ? { ...result, managedWorktree: session.managedWorktree }
      : result;
    return activity ? { ...resultWithWorktree, activity } : resultWithWorktree;
  }
}

function toStrictJson<T>(value: T): T {
  // SAFETY: callers pass schema-validated JSON-shaped data; the round trip only removes properties whose value is undefined.
  return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(JSON.stringify(value))) as T;
}

function toJsonValue(value: AppControlResult): JsonValue {
  return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(JSON.stringify(value)));
}
