import { Effect, Schema } from "effect";
import { jsonObjectSchema, jsonValueSchema, type JsonValue } from "../../ipc/json-contract";
import {
  SESSION_TITLE_MAX_LENGTH,
  thinkingLevelSchema,
  type ChatConfiguration,
  type ProjectRecord,
} from "../../ipc/session-contract";
import type { CakeChatSummary } from "../../domain/cake-chats/cake-chat-data";
import type { SessionSummary } from "../models/SessionSummary";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import type { ScheduledMessage } from "../../domain/scheduled-messages/scheduled-message-data";
import type {
  CoordinationMessage,
  CoordinationThread,
  CrossSessionDeliveryStatus,
  CrossSessionMessageMetadata,
} from "../../domain/conversations/cross-session-coordination";
import type { QueuedConversationMessages } from "../../domain/conversations/conversation-data";
import { isActiveSessionActivity, type SessionActivity } from "../lib/session-activity";
import { CakeModelSelection } from "../../domain/model-presets/cake-model-selection";
import {
  cakeSettingsSections,
  type CakeSettingsSectionId,
  type CakeSettingsSectionView,
  type CakeSettingsUpdate,
} from "../../domain/application/cake-settings-data";
import {
  CakeSettingsGetInput,
  CakeSettingsUpdateInput,
} from "../../domain/application/cake-settings-schema";

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
const sessionResolutionSchema = Schema.Struct({
  targets: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["project", "cake-chat"]),
      sessionId: bounded(1, 256),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
  resolved: Schema.Boolean,
});
const appControlArgumentSchemas = {
  "app.state": emptyArgumentsSchema,
  "app.split": Schema.Struct({ direction: Schema.Literals(["right", "down"]) }),
  "settings.sections": emptyArgumentsSchema,
  "settings.get": CakeSettingsGetInput,
  "settings.update": CakeSettingsUpdateInput,
  "sessions.list": emptyArgumentsSchema,
  "sessions.info": sessionIdTargetSchema,
  "sessions.open": sessionNavigationTargetSchema,
  "sessions.create": Schema.Struct({
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
  "sessions.create-draft": Schema.Struct({
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
  "sessions.send": Schema.Struct({
    ...sessionIdTargetSchema.fields,
    text: trimmed(1, 100_000),
    delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
    threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    maxMessages: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
    ),
  }),
  "sessions.reply": Schema.Struct({
    text: trimmed(1, 100_000),
    delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
    threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  }),
  "sessions.thread": Schema.Struct({
    threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  }),
  "sessions.close-thread": Schema.Struct({
    threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  }),
  "sessions.compact": Schema.Struct({
    ...sessionIdTargetSchema.fields,
    instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
  }),
  "sessions.schedule": Schema.Struct({
    ...sessionIdTargetSchema.fields,
    text: trimmed(1, 100_000),
    sendAt: bounded(1, 64),
  }),
  "sessions.scheduled": Schema.Struct({
    sessionId: Schema.optionalKey(bounded(1, 256)),
  }),
  "sessions.cancel-scheduled": Schema.Struct({ id: bounded(1, 256) }),
  "sessions.pending": sessionIdTargetSchema,
  "sessions.dequeue": sessionIdTargetSchema,
  "sessions.abort": sessionIdTargetSchema,
  "sessions.rename": Schema.Struct({
    ...sessionIdTargetSchema.fields,
    title: trimmed(1, SESSION_TITLE_MAX_LENGTH),
  }),
  "sessions.resolve": sessionResolutionSchema,
  "notifications.send": Schema.Struct({
    title: trimmed(1, 256),
    body: trimmed(1, 2_000),
    level: Schema.Literals(["info", "success", "warning", "error"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("info" as const)),
    ),
  }),
  "agent.action": Schema.Struct({
    action: Schema.Literals(["compact", "rename", "resolve", "restore", "set-model"]),
    detail: Schema.optionalKey(trimmed(1, 500)),
  }),
} as const;

type AppControlCommand = keyof typeof appControlArgumentSchemas;

function invocation<Command extends AppControlCommand>(command: Command) {
  return Schema.Struct({
    name: Schema.Literal(command),
    arguments: appControlArgumentSchemas[command],
  });
}

const appControlInvocationSchema = Schema.Union([
  invocation("app.state"),
  invocation("app.split"),
  invocation("settings.sections"),
  invocation("settings.get"),
  invocation("settings.update"),
  invocation("sessions.list"),
  invocation("sessions.info"),
  invocation("sessions.open"),
  invocation("sessions.create"),
  invocation("sessions.create-draft"),
  invocation("sessions.send"),
  invocation("sessions.reply"),
  invocation("sessions.thread"),
  invocation("sessions.close-thread"),
  invocation("sessions.compact"),
  invocation("sessions.schedule"),
  invocation("sessions.scheduled"),
  invocation("sessions.cancel-scheduled"),
  invocation("sessions.pending"),
  invocation("sessions.dequeue"),
  invocation("sessions.abort"),
  invocation("sessions.rename"),
  invocation("sessions.resolve"),
  invocation("notifications.send"),
  invocation("agent.action"),
]);

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
> &
  Partial<
    Pick<
      SessionSummary,
      "familyId" | "familyParentSessionId" | "familyChildSessionIds" | "familyChildOrder"
    >
  >;

type AppControlSelection =
  | { kind: "workbench" }
  | { kind: "new-project-chat" }
  | {
      kind: "project-session";
      workspacePath: string;
      workspaceName: string;
      sessionId: string;
      title: string;
    }
  | { kind: "new-cake-chat" }
  | { kind: "cake-chat"; sessionId: string; title: string }
  | { kind: "settings"; page: string };

export interface AgentControlSource {
  kind: "project-session" | "cake-chat";
  sessionId: string;
  title: string;
  projectName?: string;
  workingDirectory?: string;
}

interface AgentActionReceipt {
  message: string;
  targetSessionId?: string;
  targetKind?: "project-session" | "cake-chat";
  coalesceKey: string;
}

interface SessionCoordinationHost {
  create(
    sourceSessionId: string,
    targetSessionId: string,
    maxMessages?: number,
  ): CoordinationThread;
  get(threadId: string): CoordinationThread | undefined;
  find(sessionId: string, explicitThreadId?: string): CoordinationThread | undefined;
  record(thread: CoordinationThread, message: CoordinationMessage): void;
  refresh(thread: CoordinationThread): void;
  close(thread: CoordinationThread): void;
}

export interface AppControlHost {
  sessionCoordination: SessionCoordinationHost;
  state: {
    currentSelection(): AppControlSelection;
    sessionLayout?(source?: AgentControlSource): {
      focusedSessionId?: string;
      originSessionId?: string;
      panes: Array<{
        paneId: string;
        sessionId: string;
        number: number;
        focused: boolean;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
      neighbors?: Record<
        "left" | "right" | "above" | "below",
        Array<{ paneId: string; sessionId: string }>
      >;
    };
    projects(): readonly ProjectRecord[];
    sessions(): readonly SessionSummaryView[];
    cakeChatSessions(): readonly CakeChatSummary[];
    sessionActivity(sessionId: string): SessionActivity | undefined;
    managedWorktree(workingDirectory: string): WorktreeRecord | undefined;
  };
  settings: {
    get(section: CakeSettingsSectionId): CakeSettingsSectionView;
    update(input: CakeSettingsUpdate): Promise<CakeSettingsSectionView>;
  };
  sessions: {
    open(sessionId: string, messageId?: string): Promise<boolean | void>;
    create(input: {
      workspacePath: string;
      name: string;
      initialPrompt: string;
      model?: ChatConfiguration;
      worktreeName?: string;
    }): Promise<{ workspacePath: string; sessionId: string; managedWorktree?: WorktreeRecord }>;
    createDraft(input: {
      workspacePath: string;
      name: string;
      initialPrompt: string;
      model?: ChatConfiguration;
    }): Promise<{ workspacePath: string; sessionId: string }>;
    sendMessage(
      sessionId: string,
      text: string,
      delivery: "prompt" | "follow-up" | "steer",
      crossSession?: CrossSessionMessageMetadata,
    ): Promise<string>;
    compact(sessionId: string, instructions?: string): Promise<void>;
    scheduleMessage(input: {
      targetSessionId: string;
      text: string;
      sendAt: string;
    }): Promise<ScheduledMessage>;
    listScheduledMessages(sessionId?: string): Promise<readonly ScheduledMessage[]>;
    cancelScheduledMessage(id: string): Promise<void>;
    listPendingMessages(sessionId: string): Promise<QueuedConversationMessages>;
    dequeuePendingMessages(sessionId: string): Promise<QueuedConversationMessages>;
    abort(sessionId: string): Promise<void>;
    rename(sessionId: string, title: string): Promise<void>;
    setProjectSessionsResolved(sessionIds: readonly string[], resolved: boolean): Promise<number>;
    setCakeChatSessionsResolved(sessionIds: readonly string[], resolved: boolean): Promise<number>;
  };
  presentation: {
    splitView(
      source: AgentControlSource,
      direction: "right" | "down",
    ): { kind: "project-session" | "cake-chat"; paneId: string; sessionId: string } | undefined;
    showNotification(input: {
      title: string;
      body: string;
      level: "info" | "success" | "warning" | "error";
      source?: AgentControlSource;
    }): Promise<void>;
    showAgentAction(input: {
      source: AgentControlSource;
      message: string;
      targetSessionId?: string;
      targetKind?: "project-session" | "cake-chat";
      coalesceKey: string;
    }): void;
  };
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
  managedWorktree?: WorktreeRecord;
  familyId?: string;
  familyParentSessionId?: string;
  familyChildSessionIds?: readonly string[];
  familyChildOrder?: number;
  activity?: SessionActivity;
}

export interface AppControlState {
  selection: AppControlSelection;
  sessionLayout?: ReturnType<NonNullable<AppControlHost["state"]["sessionLayout"]>>;
  projectCount: number;
  sessionCount: number;
  projects: Array<{ path: string; name: string; sessionCount: number }>;
  attentionSessions: AppControlSession[];
  recentSessions: AppControlSession[];
}

interface CoordinationThreadView {
  threadId: string;
  state: "open" | "closed";
  participants: Array<{
    sessionId: string;
    title: string;
    projectName: string;
    workingDirectory: string;
  }>;
  messageCount: number;
  maxMessages?: number;
  messages: CoordinationMessage[];
}

export type AppControlResult =
  | { ok: true; command: "app.state"; state: AppControlState }
  | { ok: true; command: "settings.sections"; sections: typeof cakeSettingsSections }
  | {
      ok: true;
      command: "settings.get" | "settings.update";
      scope: "window";
      section: CakeSettingsSectionId;
      settings: CakeSettingsSectionView["settings"];
    }
  | {
      ok: true;
      command: "app.split";
      direction: "right" | "down";
      kind: "project-session" | "cake-chat";
      paneId: string;
      sessionId: string;
    }
  | {
      ok: true;
      command: "sessions.list";
      sessions: AppControlSession[];
      attentionSessions: AppControlSession[];
    }
  | {
      ok: true;
      command: "sessions.info";
      session: AppControlSession;
      selected: boolean;
      status: SessionActivity | "idle";
    }
  | { ok: true; command: "sessions.open"; opened: SessionTarget & { messageId?: string } }
  | {
      ok: true;
      command: "sessions.create";
      workspacePath: string;
      sessionId: string;
      title: string;
      status: "started";
      managedWorktree?: WorktreeRecord;
    }
  | {
      ok: true;
      command: "sessions.create-draft";
      workspacePath: string;
      sessionId: string;
      title: string;
      status: "saved-draft";
    }
  | {
      ok: true;
      command: "sessions.send" | "sessions.reply";
      target: SessionTarget;
      targetTitle: string;
      messageId: string;
      threadId?: string;
      messageNumber?: number;
      maxMessages?: number;
      delivery: "prompt" | "queue" | "steer";
      status: CrossSessionDeliveryStatus;
    }
  | { ok: true; command: "sessions.thread"; thread: CoordinationThreadView }
  | { ok: true; command: "sessions.close-thread"; thread: CoordinationThreadView; status: "closed" }
  | { ok: true; command: "sessions.compact"; target: SessionTarget; status: "compacted" }
  | {
      ok: true;
      command: "sessions.schedule";
      target: SessionTarget;
      scheduledMessage: ScheduledMessage;
      status: "scheduled";
    }
  | { ok: true; command: "sessions.scheduled"; messages: readonly ScheduledMessage[] }
  | { ok: true; command: "sessions.cancel-scheduled"; id: string; status: "cancelled" }
  | {
      ok: true;
      command: "sessions.pending" | "sessions.dequeue";
      messages: QueuedConversationMessages;
    }
  | { ok: true; command: "sessions.abort"; target: SessionTarget; status: "stopping" }
  | { ok: true; command: "sessions.rename"; target: SessionTarget; title: string }
  | {
      ok: true;
      command: "sessions.resolve";
      targets: ReadonlyArray<{ kind: "project" | "cake-chat"; sessionId: string }>;
      resolved: boolean;
      sessionCount: number;
    }
  | { ok: true; command: "notifications.send"; status: "queued" }
  | {
      ok: true;
      command: "agent.action";
      action: "compact" | "rename" | "resolve" | "restore" | "set-model";
      detail?: string;
    }
  | { ok: false; command: AppControlCommand; error: string };

interface SessionTarget {
  workspacePath: string;
  sessionId: string;
}

const createSessionOperationSchema = Schema.Struct({
  ...appControlArgumentSchemas["sessions.create"].fields,
  model: Schema.optionalKey(CakeModelSelection),
});
const createDraftSessionOperationSchema = Schema.Struct({
  ...appControlArgumentSchemas["sessions.create-draft"].fields,
  model: Schema.optionalKey(CakeModelSelection),
});

const modelControlOperations = [
  operation(
    "app.state",
    "app",
    "Inspect Cake's current selection, split-pane layout, directional neighbors, and project and session summaries.",
    appControlArgumentSchemas["app.state"],
  ),
  operation(
    "app.split",
    "app",
    "Split the calling conversation pane to the right or down and open a new chat in it.",
    appControlArgumentSchemas["app.split"],
  ),
  operation(
    "settings.sections",
    "settings",
    "List the Cake settings sections available to agents, including scope and writability.",
    appControlArgumentSchemas["settings.sections"],
  ),
  operation(
    "settings.get",
    "settings",
    "Read the effective settings for one Cake settings section in the invoking window.",
    appControlArgumentSchemas["settings.get"],
  ),
  {
    ...operation(
      "settings.update",
      "settings",
      "Patch one Cake settings section in the invoking window and return its committed effective settings.",
      appControlArgumentSchemas["settings.update"],
    ),
    guidance: [
      "Call settings.get before updating a section. Unspecified fields remain unchanged.",
      "For hotkeys, null restores the default binding and an empty string disables the shortcut.",
    ],
    examples: [
      {
        input: { section: "appearance", changes: { theme: "dark" } },
        description: "Use Cake's dark appearance in this window.",
      },
    ],
  },
  operation(
    "sessions.list",
    "sessions",
    "List all project sessions, ordered by recency, and attention-worthy project sessions.",
    appControlArgumentSchemas["sessions.list"],
  ),
  operation(
    "sessions.info",
    "sessions",
    "Inspect one explicitly targeted project session.",
    appControlArgumentSchemas["sessions.info"],
  ),
  operation(
    "sessions.open",
    "sessions",
    "Open one explicitly targeted project session, optionally at a specific transcript message.",
    appControlArgumentSchemas["sessions.open"],
  ),
  {
    ...operation(
      "sessions.create",
      "sessions",
      "Create, configure, name, and start a project session in the background, optionally from a model preset or in a new managed worktree.",
      createSessionOperationSchema,
    ),
    guidance: [
      "When model is omitted, the new session inherits the calling Cake Chat's current model, thinking level, and Fast mode setting.",
    ],
    examples: [
      {
        input: {
          workspacePath: "/path/to/project",
          name: "Authentication follow-up",
          initialPrompt: "Review the authentication flow and implement the next changes.",
          model: "Sol",
        },
        description: "Select a configured preset by name.",
      },
    ],
  },
  {
    ...operation(
      "sessions.create-draft",
      "sessions",
      "Create, configure, name, and save an initial prompt as a background Cake-owned draft without starting a Pi session.",
      createDraftSessionOperationSchema,
    ),
    guidance: [
      "When model is omitted, the draft snapshots the calling Cake Chat's current model, thinking level, and Fast mode setting.",
    ],
    examples: [
      {
        input: {
          workspacePath: "/path/to/project",
          name: "Authentication follow-up",
          initialPrompt: "Review the authentication flow and propose the next changes.",
          model: "Sol",
        },
        description: "Select a configured preset by name.",
      },
    ],
  },
  operation(
    "sessions.send",
    "sessions",
    "Send, queue, or steer a correlated message to one explicitly targeted session. The result is a visible delivery receipt; optional maxMessages bounds the exchange.",
    appControlArgumentSchemas["sessions.send"],
  ),
  operation(
    "sessions.reply",
    "sessions",
    "Reply to the originating session in the current open coordination thread without supplying a session ID.",
    appControlArgumentSchemas["sessions.reply"],
  ),
  operation(
    "sessions.thread",
    "sessions",
    "Inspect the current coordination thread, correlated messages, delivery states, participants, and optional message limit.",
    appControlArgumentSchemas["sessions.thread"],
  ),
  operation(
    "sessions.close-thread",
    "sessions",
    "Close the current coordination thread. Further replies are rejected; late arrivals remain attributed to the closed exchange.",
    appControlArgumentSchemas["sessions.close-thread"],
  ),
  operation(
    "sessions.compact",
    "sessions",
    "Compact one explicitly targeted Project Session through Pi's normal compaction mechanism.",
    appControlArgumentSchemas["sessions.compact"],
  ),
  operation(
    "sessions.schedule",
    "sessions",
    "Schedule a message for one explicitly targeted Project Session at an ISO timestamp.",
    appControlArgumentSchemas["sessions.schedule"],
  ),
  operation(
    "sessions.scheduled",
    "sessions",
    "List scheduled messages, optionally filtered to one Project Session.",
    appControlArgumentSchemas["sessions.scheduled"],
  ),
  operation(
    "sessions.cancel-scheduled",
    "sessions",
    "Cancel one scheduled message by its ID.",
    appControlArgumentSchemas["sessions.cancel-scheduled"],
  ),
  operation(
    "sessions.pending",
    "sessions",
    "List all steering and follow-up messages currently queued in one explicitly targeted Project Session.",
    appControlArgumentSchemas["sessions.pending"],
  ),
  operation(
    "sessions.dequeue",
    "sessions",
    "Clear and return all steering and follow-up messages queued in one explicitly targeted Project Session. To edit queued content, dequeue it, modify the returned text, then use sessions.send.",
    appControlArgumentSchemas["sessions.dequeue"],
  ),
  operation(
    "sessions.abort",
    "sessions",
    "Stop one explicitly targeted running session.",
    appControlArgumentSchemas["sessions.abort"],
  ),
  operation(
    "sessions.rename",
    "sessions",
    "Rename one explicitly targeted Project Session to a new title.",
    appControlArgumentSchemas["sessions.rename"],
  ),
  operation(
    "notifications.send",
    "notifications",
    "Send a bounded native system notification without adding user input.",
    appControlArgumentSchemas["notifications.send"],
  ),
  operation(
    "sessions.resolve",
    "sessions",
    "Idempotently resolve or restore explicit project or Cake Chat targets.",
    appControlArgumentSchemas["sessions.resolve"],
  ),
] as const;

function operation(
  command: AppControlCommand,
  topic: string,
  summary: string,
  schema: Schema.Constraint,
) {
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

  getAppState(source?: AgentControlSource): AppControlState {
    const sessions = this.sortedSessions();
    const state: AppControlState = {
      selection: this.host.state.currentSelection(),
      projectCount: this.host.state.projects().length,
      sessionCount: sessions.length,
      projects: this.host.state.projects().map((project) => ({
        path: project.path,
        name: project.name,
        sessionCount: sessions.filter((session) => session.workingDirectory === project.path)
          .length,
      })),
      attentionSessions: sessions
        .filter((session) => this.host.state.sessionActivity(session.sessionId))
        .map((session) => this.toControlSession(session)),
      recentSessions: sessions.map((session) => this.toControlSession(session)),
    };
    const sessionLayout = this.host.state.sessionLayout?.(source);
    if (sessionLayout) state.sessionLayout = sessionLayout;
    return state;
  }

  async invoke(untrustedInput: unknown, source?: AgentControlSource): Promise<JsonValue> {
    const result = await this.invokeResult(untrustedInput, source);
    if (source && result.ok && result.command !== "notifications.send") {
      const receipt = this.agentActionReceipt(result, source);
      if (receipt) this.host.presentation.showAgentAction({ source, ...receipt });
    }
    return toJsonValue(result);
  }

  private async invokeResult(
    untrustedInput: unknown,
    source?: AgentControlSource,
  ): Promise<AppControlResult> {
    const invocation = Schema.decodeUnknownSync(appControlInvocationSchema)(untrustedInput);
    const command = invocation.name;
    if (invocation.name === "settings.sections")
      return { ok: true, command: invocation.name, sections: cakeSettingsSections };
    if (invocation.name === "settings.get") {
      const view = this.host.settings.get(invocation.arguments.section);
      return toStrictJson({ ok: true, command: invocation.name, scope: "window", ...view });
    }
    if (invocation.name === "settings.update") {
      const view = await this.host.settings.update(invocation.arguments);
      return toStrictJson({ ok: true, command: invocation.name, scope: "window", ...view });
    }
    if (invocation.name === "sessions.list") {
      const state = this.getAppState(source);
      return toStrictJson({
        ok: true,
        command: invocation.name,
        sessions: state.recentSessions,
        attentionSessions: state.attentionSessions,
      });
    }
    if (invocation.name === "sessions.resolve") return this.resolveSessions(invocation.arguments);
    if (invocation.name === "app.state")
      return { ok: true, command: invocation.name, state: this.getAppState(source) };
    if (invocation.name === "app.split") {
      if (!source)
        return {
          ok: false,
          command,
          error: "Cake can only split a pane for a calling conversation.",
        };
      const split = this.host.presentation.splitView(source, invocation.arguments.direction);
      if (!split)
        return { ok: false, command, error: "Cake could not split that conversation pane." };
      return {
        ok: true,
        command: invocation.name,
        direction: invocation.arguments.direction,
        ...split,
      };
    }
    if (invocation.name === "notifications.send") {
      await this.host.presentation.showNotification({
        title: invocation.arguments.title,
        body: invocation.arguments.body,
        level: invocation.arguments.level,
        source,
      });
      return { ok: true, command: invocation.name, status: "queued" };
    }
    if (invocation.name === "agent.action") {
      const result: Extract<AppControlResult, { command: "agent.action" }> = {
        ok: true,
        command: invocation.name,
        action: invocation.arguments.action,
      };
      if (invocation.arguments.detail) result.detail = invocation.arguments.detail;
      return result;
    }
    if (invocation.name === "sessions.create") return this.createSession(invocation.arguments);
    if (invocation.name === "sessions.create-draft")
      return this.createDraftSession(invocation.arguments);
    if (invocation.name === "sessions.scheduled") {
      if (invocation.arguments.sessionId && !this.knownSession(invocation.arguments.sessionId))
        return { ok: false, command, error: "Cake could not find that session." };
      return {
        ok: true,
        command: invocation.name,
        messages: await this.host.sessions.listScheduledMessages(invocation.arguments.sessionId),
      };
    }
    if (invocation.name === "sessions.cancel-scheduled") {
      await this.host.sessions.cancelScheduledMessage(invocation.arguments.id);
      return {
        ok: true,
        command: invocation.name,
        id: invocation.arguments.id,
        status: "cancelled",
      };
    }
    if (invocation.name === "sessions.reply") {
      if (!source) return { ok: false, command, error: "Reply requires a calling session." };
      const thread = this.findThread(source.sessionId, invocation.arguments.threadId);
      if (!thread) return { ok: false, command, error: "There is no matching session thread." };
      if (thread.state === "closed")
        return { ok: false, command, error: "That session thread is closed." };
      const targetSessionId = thread.participants.find((id) => id !== source.sessionId);
      if (!targetSessionId) return { ok: false, command, error: "The thread has no reply target." };
      return this.sendCrossSessionMessage(
        invocation.name,
        targetSessionId,
        invocation.arguments.text,
        invocation.arguments.delivery,
        source,
        thread,
      );
    }
    if (invocation.name === "sessions.thread" || invocation.name === "sessions.close-thread") {
      if (!source)
        return { ok: false, command, error: "Thread access requires a calling session." };
      const thread = this.findThread(source.sessionId, invocation.arguments.threadId);
      if (!thread) return { ok: false, command, error: "There is no matching session thread." };
      if (invocation.name === "sessions.close-thread") this.host.sessionCoordination.close(thread);
      const view = this.threadView(thread);
      return invocation.name === "sessions.close-thread"
        ? { ok: true, command: invocation.name, thread: view, status: "closed" }
        : { ok: true, command: invocation.name, thread: view };
    }

    const { sessionId } = invocation.arguments;
    const known = this.knownSession(sessionId);
    if (!known) return { ok: false, command, error: "Cake could not find that session." };
    const workspacePath = known.workingDirectory;
    const target = { workspacePath, sessionId };

    if (invocation.name === "sessions.pending")
      return {
        ok: true,
        command: invocation.name,
        messages: await this.host.sessions.listPendingMessages(sessionId),
      };
    if (invocation.name === "sessions.dequeue")
      return {
        ok: true,
        command: invocation.name,
        messages: await this.host.sessions.dequeuePendingMessages(sessionId),
      };
    if (invocation.name === "sessions.info") {
      const activity = this.host.state.sessionActivity(sessionId);
      const current = this.host.state.currentSelection();
      return {
        ok: true,
        command: invocation.name,
        session: this.toControlSession(known),
        selected: current.kind === "project-session" && current.sessionId === sessionId,
        status: activity ?? "idle",
      };
    }
    if (invocation.name === "sessions.open") {
      const { messageId } = invocation.arguments;
      const messageFound = messageId
        ? await this.host.sessions.open(sessionId, messageId)
        : await this.host.sessions.open(sessionId);
      if (messageId && messageFound === false)
        return {
          ok: false,
          command,
          error: `Cake could not find message ${messageId} in that session.`,
        };
      return {
        ok: true,
        command: invocation.name,
        opened: messageId ? { ...target, messageId } : target,
      };
    }
    if (invocation.name === "sessions.send") {
      if (!source) {
        const delivery =
          invocation.arguments.delivery ??
          (isActiveSessionActivity(this.host.state.sessionActivity(sessionId))
            ? "queue"
            : "prompt");
        const turnId = await this.host.sessions.sendMessage(
          sessionId,
          invocation.arguments.text,
          delivery === "queue" ? "follow-up" : delivery,
        );
        return {
          ok: true,
          command: invocation.name,
          target,
          targetTitle: known.title,
          messageId: turnId,
          delivery,
          status: delivery === "queue" ? "queued" : "accepted",
        };
      }
      let thread = invocation.arguments.threadId
        ? this.host.sessionCoordination.get(invocation.arguments.threadId)
        : undefined;
      if (invocation.arguments.threadId && !thread)
        return { ok: false, command, error: "Cake could not find that session thread." };
      if (thread && !thread.participants.includes(source.sessionId))
        return { ok: false, command, error: "The calling session is not in that thread." };
      if (thread?.state === "closed")
        return { ok: false, command, error: "That session thread is closed." };
      if (
        thread &&
        invocation.arguments.maxMessages !== undefined &&
        invocation.arguments.maxMessages !== thread.maxMessages
      )
        return {
          ok: false,
          command,
          error: "The existing thread has a different message limit.",
        };
      if (!thread) {
        thread = this.host.sessionCoordination.create(
          source.sessionId,
          sessionId,
          invocation.arguments.maxMessages,
        );
      }
      if (!thread.participants.includes(sessionId))
        return { ok: false, command, error: "The target is not in that thread." };
      return this.sendCrossSessionMessage(
        invocation.name,
        sessionId,
        invocation.arguments.text,
        invocation.arguments.delivery,
        source,
        thread,
      );
    }
    if (invocation.name === "sessions.compact") {
      await this.host.sessions.compact(sessionId, invocation.arguments.instructions);
      return { ok: true, command: invocation.name, target, status: "compacted" };
    }
    if (invocation.name === "sessions.schedule") {
      const scheduledMessage = await this.host.sessions.scheduleMessage({
        targetSessionId: sessionId,
        text: invocation.arguments.text,
        sendAt: invocation.arguments.sendAt,
      });
      return {
        ok: true,
        command: invocation.name,
        target,
        scheduledMessage,
        status: "scheduled",
      };
    }
    if (invocation.name === "sessions.abort") {
      if (!isActiveSessionActivity(this.host.state.sessionActivity(sessionId)))
        return { ok: false, command, error: "That session is not currently running." };
      await this.host.sessions.abort(sessionId);
      return { ok: true, command: invocation.name, target, status: "stopping" };
    }
    await this.host.sessions.rename(sessionId, invocation.arguments.title);
    return { ok: true, command: invocation.name, target, title: invocation.arguments.title };
  }

  private async resolveSessions(
    input: (typeof appControlArgumentSchemas)["sessions.resolve"]["Type"],
  ): Promise<AppControlResult> {
    const command = "sessions.resolve";
    const projectIds = input.targets
      .filter((target) => target.kind === "project")
      .map((target) => target.sessionId);
    const cakeChatIds = input.targets
      .filter((target) => target.kind === "cake-chat")
      .map((target) => target.sessionId);
    const unknownProject = projectIds.find((sessionId) => !this.knownSession(sessionId));
    if (unknownProject)
      return { ok: false, command, error: `Cake could not find session ${unknownProject}.` };
    const knownCakeChatIds = new Set(
      this.host.state.cakeChatSessions().map((session) => session.sessionId),
    );
    const unknownCakeChat = cakeChatIds.find((sessionId) => !knownCakeChatIds.has(sessionId));
    if (unknownCakeChat)
      return {
        ok: false,
        command,
        error: `Cake could not find Cake Chat session ${unknownCakeChat}.`,
      };
    const [projectCount, cakeChatCount] = await Promise.all([
      projectIds.length
        ? this.host.sessions.setProjectSessionsResolved([...new Set(projectIds)], input.resolved)
        : 0,
      cakeChatIds.length
        ? this.host.sessions.setCakeChatSessionsResolved([...new Set(cakeChatIds)], input.resolved)
        : 0,
    ]);
    return toStrictJson({
      ok: true,
      command,
      targets: input.targets,
      resolved: input.resolved,
      sessionCount: projectCount + cakeChatCount,
    });
  }

  private findThread(sessionId: string, explicitThreadId?: string) {
    return this.host.sessionCoordination.find(sessionId, explicitThreadId);
  }

  private async sendCrossSessionMessage(
    command: "sessions.send" | "sessions.reply",
    targetSessionId: string,
    text: string,
    requestedDelivery: "prompt" | "queue" | "steer" | undefined,
    source: AgentControlSource,
    thread: CoordinationThread,
  ): Promise<AppControlResult> {
    const target = this.knownSession(targetSessionId);
    if (!target)
      return { ok: false, command, error: "Cake could not find the thread's target session." };
    if (targetSessionId === source.sessionId)
      return { ok: false, command, error: "A session thread requires two different sessions." };
    if (thread.maxMessages !== undefined && thread.messages.length >= thread.maxMessages) {
      this.host.sessionCoordination.close(thread);
      return { ok: false, command, error: "That session thread reached its message limit." };
    }
    const delivery =
      requestedDelivery ??
      (isActiveSessionActivity(this.host.state.sessionActivity(targetSessionId))
        ? "queue"
        : "prompt");
    const messageId = crypto.randomUUID();
    const sequence = thread.messages.length + 1;
    const metadata: CrossSessionMessageMetadata = {
      version: 1,
      messageId,
      threadId: thread.threadId,
      sequence,
      sender: {
        sessionId: source.sessionId,
        title: source.title,
        kind: source.kind,
        ...(source.projectName ? { projectName: source.projectName } : null),
        ...(source.workingDirectory ? { workingDirectory: source.workingDirectory } : null),
      },
      ...(thread.maxMessages !== undefined ? { maxMessages: thread.maxMessages } : null),
    };
    const message: CoordinationMessage = {
      messageId,
      senderSessionId: source.sessionId,
      targetSessionId,
      turnId: messageId,
      delivery,
      status: delivery === "queue" ? "queued" : "accepted",
    };
    // Reserve the sequence before crossing the async boundary so simultaneous
    // participants cannot receive the same message number or exceed the limit.
    this.host.sessionCoordination.record(thread, message);
    try {
      message.turnId = await this.host.sessions.sendMessage(
        targetSessionId,
        text,
        delivery === "queue" ? "follow-up" : delivery,
        metadata,
      );
    } catch (error) {
      message.status = "failed";
      throw error;
    }
    if (thread.maxMessages !== undefined && sequence >= thread.maxMessages)
      this.host.sessionCoordination.close(thread);
    return {
      ok: true,
      command,
      target: { workspacePath: target.workingDirectory, sessionId: targetSessionId },
      targetTitle: target.title,
      messageId,
      threadId: thread.threadId,
      messageNumber: sequence,
      maxMessages: thread.maxMessages,
      delivery,
      status: message.status,
    };
  }

  private threadView(thread: CoordinationThread): CoordinationThreadView {
    this.host.sessionCoordination.refresh(thread);
    const participants = thread.participants.map((sessionId) => {
      const session = this.knownSession(sessionId);
      return {
        sessionId,
        title: session?.title ?? "Session",
        projectName: session?.projectName ?? "Unknown project",
        workingDirectory: session?.workingDirectory ?? "Unknown working directory",
      };
    });
    return {
      threadId: thread.threadId,
      state: thread.state,
      participants,
      messageCount: thread.messages.length,
      maxMessages: thread.maxMessages,
      messages: thread.messages.map((message) => ({ ...message })),
    };
  }

  private agentActionReceipt(
    result: Extract<AppControlResult, { ok: true }>,
    source: AgentControlSource,
  ): AgentActionReceipt | undefined {
    const projectTitle = (sessionId: string) =>
      this.host.state.sessions().find((session) => session.sessionId === sessionId)?.title ??
      "Session";
    const projectTarget = (sessionId: string) => ({
      targetSessionId: sessionId,
      targetKind: "project-session" as const,
    });
    const resolutionKey = (
      resolved: boolean,
      targets: ReadonlyArray<{ sessionId: string; kind: "project-session" | "cake-chat" }>,
    ) =>
      `resolve:${targets.map((target) => `${target.kind}:${target.sessionId}`).join(",")}:${resolved}`;
    const resolutionReceipt = (
      message: string,
      resolved: boolean,
      targets: ReadonlyArray<{ sessionId: string; kind: "project-session" | "cake-chat" }>,
      target?: { sessionId: string; kind: "project-session" | "cake-chat" },
    ) => {
      const receipt: AgentActionReceipt = {
        message,
        coalesceKey: resolutionKey(resolved, targets),
      };
      if (target) {
        receipt.targetSessionId = target.sessionId;
        receipt.targetKind = target.kind;
      }
      return receipt;
    };
    if (result.command === "agent.action") {
      const messages = {
        compact: "Compacted this session",
        rename: `Renamed this session${result.detail ? ` to “${result.detail}”` : ""}`,
        resolve: "Resolved this session",
        restore: "Restored this session",
        "set-model": `Changed this session’s model${result.detail ? ` to ${result.detail}` : ""}`,
      } as const;
      return {
        message: messages[result.action],
        targetSessionId: source.sessionId,
        targetKind: source.kind,
        coalesceKey:
          result.action === "resolve" || result.action === "restore"
            ? resolutionKey(result.action === "resolve", [
                { sessionId: source.sessionId, kind: source.kind },
              ])
            : `current:${result.action}:${result.detail ?? ""}`,
      };
    }
    if (result.command === "settings.update")
      return {
        message: `Updated Cake ${result.section} settings`,
        coalesceKey: `settings:${result.section}`,
      };
    if (result.command === "app.split")
      return {
        message: `Split this chat ${result.direction === "right" ? "to the right" : "down"}`,
        targetSessionId: result.sessionId,
        targetKind: result.kind,
        coalesceKey: `split:${result.paneId}`,
      };
    if (result.command === "sessions.open")
      return {
        message: `Opened “${projectTitle(result.opened.sessionId)}”`,
        coalesceKey: `open:${result.opened.sessionId}`,
      };
    if (result.command === "sessions.create")
      return {
        message: `Created and started “${result.title}”`,
        ...projectTarget(result.sessionId),
        coalesceKey: `create:${result.sessionId}`,
      };
    if (result.command === "sessions.create-draft")
      return {
        message: `Created draft “${result.title}”`,
        ...projectTarget(result.sessionId),
        coalesceKey: `draft:${result.sessionId}`,
      };
    if (result.command === "sessions.send" || result.command === "sessions.reply")
      return {
        message: `${result.status === "queued" ? "Queued" : "Accepted"} message ${result.messageNumber ? `${result.messageNumber}${result.maxMessages ? `/${result.maxMessages}` : ""} for` : "for"} “${result.targetTitle}”`,
        ...projectTarget(result.target.sessionId),
        coalesceKey: `send:${result.messageId}:${result.status}`,
      };
    if (result.command === "sessions.close-thread")
      return {
        message: `Closed session exchange after ${result.thread.messageCount} messages`,
        coalesceKey: `thread-close:${result.thread.threadId}`,
      };
    if (result.command === "sessions.compact")
      return {
        message: `Compacted “${projectTitle(result.target.sessionId)}”`,
        ...projectTarget(result.target.sessionId),
        coalesceKey: `compact:${result.target.sessionId}`,
      };
    if (result.command === "sessions.schedule")
      return {
        message: `Scheduled a message for “${projectTitle(result.target.sessionId)}”`,
        ...projectTarget(result.target.sessionId),
        coalesceKey: `schedule:${result.target.sessionId}`,
      };
    if (result.command === "sessions.cancel-scheduled")
      return { message: "Cancelled a scheduled message", coalesceKey: `cancel:${result.id}` };
    if (result.command === "sessions.abort")
      return {
        message: `Stopped “${projectTitle(result.target.sessionId)}”`,
        ...projectTarget(result.target.sessionId),
        coalesceKey: `abort:${result.target.sessionId}`,
      };
    if (result.command === "sessions.rename")
      return {
        message: `Renamed session to “${result.title}”`,
        ...projectTarget(result.target.sessionId),
        coalesceKey: `rename:${result.target.sessionId}`,
      };
    if (result.command === "sessions.resolve") {
      const target = result.targets.length === 1 ? result.targets[0] : undefined;
      const targets = result.targets.map((item) => ({
        sessionId: item.sessionId,
        kind: item.kind === "cake-chat" ? ("cake-chat" as const) : ("project-session" as const),
      }));
      return resolutionReceipt(
        `${result.resolved ? "Resolved" : "Restored"} ${result.sessionCount} ${result.sessionCount === 1 ? "session" : "sessions"}`,
        result.resolved,
        targets,
        target ? targets[0] : undefined,
      );
    }
    return undefined;
  }

  private sortedSessions() {
    return [...this.host.state.sessions()].sort((left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt),
    );
  }

  private knownSession(sessionId: string) {
    return this.host.state.sessions().find((session) => session.sessionId === sessionId);
  }

  private async createSession(
    input: (typeof appControlArgumentSchemas)["sessions.create"]["Type"],
  ): Promise<AppControlResult> {
    const command = "sessions.create";
    if (!this.host.state.projects().some((project) => project.path === input.workspacePath))
      return { ok: false, command, error: "Cake could not find that project." };
    const created = await this.host.sessions.create(input);
    const result: Extract<AppControlResult, { ok: true; command: "sessions.create" }> = {
      ok: true,
      command,
      workspacePath: created.workspacePath,
      sessionId: created.sessionId,
      title: input.name,
      status: "started",
    };
    if (created.managedWorktree) result.managedWorktree = created.managedWorktree;
    return result;
  }

  private async createDraftSession(
    input: (typeof appControlArgumentSchemas)["sessions.create-draft"]["Type"],
  ): Promise<AppControlResult> {
    const command = "sessions.create-draft";
    if (!this.host.state.projects().some((project) => project.path === input.workspacePath))
      return { ok: false, command, error: "Cake could not find that project." };
    const created = await this.host.sessions.createDraft(input);
    return {
      ok: true,
      command,
      workspacePath: created.workspacePath,
      sessionId: created.sessionId,
      title: input.name,
      status: "saved-draft",
    };
  }

  private toControlSession(session: SessionSummaryView): AppControlSession {
    const activity = this.host.state.sessionActivity(session.sessionId);
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
    const managedWorktree = this.host.state.managedWorktree(session.workingDirectory);
    const resultWithWorktree = managedWorktree ? { ...result, managedWorktree } : result;
    const resultWithFamily = session.familyId
      ? {
          ...resultWithWorktree,
          familyId: session.familyId,
          familyParentSessionId: session.familyParentSessionId,
          familyChildSessionIds: session.familyChildSessionIds,
          familyChildOrder: session.familyChildOrder,
        }
      : resultWithWorktree;
    return activity ? { ...resultWithFamily, activity } : resultWithFamily;
  }
}

function toStrictJson<T>(value: T): T {
  // SAFETY: callers pass schema-validated JSON-shaped data; the round trip only removes properties whose value is undefined.
  return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(JSON.stringify(value))) as T;
}

function toJsonValue(value: AppControlResult): JsonValue {
  return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(JSON.stringify(value)));
}
