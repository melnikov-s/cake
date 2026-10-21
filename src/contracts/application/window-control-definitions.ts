import { ResultDelivery, resultDeliveryGuidance } from "../conversations/result-delivery";
import { Effect, Schema } from "effect";
import { CakeControlTool } from "../cake-chats/cake-chat-data";
import { backendAgentTools } from "./backend-agent-tools";
import { backendAgentSettingsTools } from "./agent-settings-tools";
import { QueuedSessionCommand } from "../conversations/session-query-data";
import { SESSION_TITLE_MAX_LENGTH, thinkingLevelSchema } from "../conversations/session-contract";
import { messageRefsSchema } from "../conversations/message-reference";
import { inputRefsSchema } from "../conversations/task-input";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { SessionNavigationInput, sessionNavigationHelp } from "./session-navigation";
import { PROJECT_TODO_AUTO_COMPLETION_RULE } from "../projects/project-todos";
import {
  AgentPendingListInput,
  AgentPendingReadInput,
} from "../conversations/agent-pending-messages";
import {
  AgentScheduledListInput,
  AgentScheduledReadInput,
} from "../scheduled-messages/agent-scheduled-messages";

const bounded = (min: number, max: number) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const trimmed = (min: number, max: number) =>
  Schema.Trim.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const sessionIdTargetSchema = Schema.Struct({ sessionId: bounded(1, 256) });
const emptyArgumentsSchema = Schema.Struct({});

const createSessionArgs = Schema.Struct({
  messageRefs: Schema.optionalKey(messageRefsSchema),
  inputRefs: Schema.optionalKey(inputRefsSchema),
  workspacePath: bounded(1, 4096),
  name: trimmed(1, 500),
  initialPrompt: trimmed(1, 100000),
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
  resultDelivery: Schema.optionalKey(ResultDelivery),
});
const createDraftSessionArgs = Schema.Struct({
  workspacePath: bounded(1, 4096),
  name: trimmed(1, 500),
  initialPrompt: trimmed(1, 100000),
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
});
/** Data-only window controls shared by chat runtime discovery and renderer execution. */
export const windowControlDefinitions = {
  "app.state": {
    command: "app.state",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "app",
      summary:
        "Inspect Cake's current selection, split-pane layout, directional neighbors and collection counts; use projects.list/sessions.list for discovery.",
    },
  },
  "app.user-selection": {
    command: "app.user-selection",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "app",
      summary: "Read the text currently highlighted by the user in the Cake window.",
      result: "The currently selected text, or no text if nothing is highlighted in Cake.",
    },
  },
  "app.split": {
    command: "app.split",
    args: Schema.Struct({ direction: Schema.Literals(["right", "down"]) }),
    scope: "global",
    discovery: {
      topic: "app",
      summary:
        "Split the calling conversation pane to the right or down and open a new chat in it.",
    },
  },
  "notifications.send": {
    command: "notifications.send",
    args: Schema.Struct({
      title: trimmed(1, 256),
      body: trimmed(1, 2000),
      level: Schema.Literals(["info", "success", "warning", "error"]).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("info" as const)),
      ),
    }),
    scope: "global",
    discovery: {
      topic: "notifications",
      summary: "Send a bounded native system notification without adding user input.",
    },
  },
  "sessions.queue-command": {
    command: "sessions.queue-command",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      ...QueuedSessionCommand.fields,
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Queue a slash command to execute between responses without interrupting the active response.",
      guidance: [
        "Inspect sessions.commands for queueable commands. /compact accepts instructions; /toolcompact takes no arguments and uses the latest completed assistant response when executed.",
        "Commands share the follow-up queue with messages and preserve its order. Use sessions.pending, sessions.reorder, or sessions.cancel-queued to inspect, reorder or cancel pending work.",
        "The receipt confirms acceptance, not completion. Commands cannot be steered into a running response. Pending commands are process-lifetime state, not durable scheduling.",
      ],
      examples: [
        {
          input: {
            sessionId: "parent-session-id",
            command: "/toolcompact",
          },
        },
      ],
    },
  },
  "sessions.reorder": {
    command: "sessions.reorder",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      itemId: Schema.String.check(Schema.isUUID(4)),
      position: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Move a queued command or message to a one-based position within its existing lane.",
    },
  },
  "sessions.pending": {
    command: "sessions.pending",
    args: AgentPendingListInput,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "List bounded queue identities, short labels, lanes and positions; offset/limit page results, pending-info reads exact text.",
    },
  },
  "sessions.pending-info": {
    command: "sessions.pending-info",
    args: AgentPendingReadInput,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Read one exact live queued input in bounded text slices (maxChars up to 20000).",
    },
  },

  "sessions.cancel-queued": {
    command: "sessions.cancel-queued",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      partId: bounded(1, 256),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Cancel one queued message in an explicitly targeted Project Session by its projected partId.",
    },
  },
  "sessions.steer-queued": {
    command: "sessions.steer-queued",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      partId: bounded(1, 256),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Move one queued follow-up message to the steering lane of an explicitly targeted Project Session by its projected partId.",
    },
  },
  "sessions.send-now": {
    command: "sessions.send-now",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      partId: bounded(1, 256),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Stop the active turn and send one queued message now in an explicitly targeted Project Session by its projected partId. Other queued messages remain queued.",
    },
  },
  "sessions.clear-queue": {
    command: "sessions.clear-queue",
    args: sessionIdTargetSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Clear queued steering/follow-up inputs and return cleared counts, never message contents. Read selected items before clearing if needed.",
    },
  },
  "sessions.create": {
    command: "sessions.create",
    args: createSessionArgs,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Create, configure, name, and start a project session in the background, optionally from a model preset or in a new managed worktree.",
      guidance: [
        "Omit model unless the user explicitly asks for a specific model. When omitted, the new session uses the configured default model preset's complete settings (provider, model, thinking level, and Fast mode; see models.list), not the calling Cake Chat's current model. Only when no default preset is configured does it use the calling Cake Chat's current settings.",
        "Pass exact attachment IDs from input metadata or attachments.list in inputRefs to forward without reading. Use attachments.read only when you want to inspect the content yourself.",
        resultDeliveryGuidance,
        "Defaults to notification. Later unrelated local user turns never notify the creator.",
      ],
      examples: [
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication follow-up",
            initialPrompt: "Review the authentication flow and implement the next changes.",
          },
          description: "Use the configured default model.",
        },
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication review",
            initialPrompt: "Review the authentication flow.",
            model: "Sol",
          },
          description:
            "Only when the user asks for a specific model: select a configured preset by name.",
        },
      ],
    },
    discoveryArgs: Schema.Struct({
      ...createSessionArgs.fields,
      model: Schema.optionalKey(CakeModelSelection),
    }),
  },
  "sessions.create-draft": {
    command: "sessions.create-draft",
    args: createDraftSessionArgs,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Create, configure, name, and save an initial prompt as a background Cake-owned draft without starting a Pi session.",
      guidance: [
        "Omit model unless the user explicitly asks for a specific model. When omitted, the draft uses the configured default model preset's complete settings (provider, model, thinking level, and Fast mode; see models.list), not the calling Cake Chat's current model. Only when no default preset is configured does it use the calling Cake Chat's current settings.",
      ],
      examples: [
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication follow-up",
            initialPrompt: "Review the authentication flow and propose the next changes.",
          },
          description: "Use the configured default model.",
        },
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication review",
            initialPrompt: "Review the authentication flow.",
            model: "Sol",
          },
          description:
            "Only when the user asks for a specific model: select a configured preset by name.",
        },
      ],
    },
    discoveryArgs: Schema.Struct({
      ...createDraftSessionArgs.fields,
      model: Schema.optionalKey(CakeModelSelection),
    }),
  },
  "sessions.schedule": {
    command: "sessions.schedule",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      text: trimmed(1, 100000),
      sendAt: bounded(1, 64),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Schedule a message for one explicitly targeted Project Session at an ISO timestamp.",
    },
  },
  "sessions.scheduled": {
    command: "sessions.scheduled",
    args: AgentScheduledListInput,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "List bounded scheduled-message IDs, destinations, send times and short labels; filter session/query before offset/limit pagination.",
    },
  },
  "sessions.scheduled-info": {
    command: "sessions.scheduled-info",
    args: AgentScheduledReadInput,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Read one scheduled message by exact ID in bounded text slices (maxChars up to 20000).",
    },
  },
  "sessions.cancel-scheduled": {
    command: "sessions.cancel-scheduled",
    args: Schema.Struct({ id: bounded(1, 256) }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Cancel one scheduled message by its ID.",
    },
  },
  "sessions.abort": {
    command: "sessions.abort",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      reason: Schema.optionalKey(trimmed(1, 500)),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Stop one explicitly targeted running session.",
      guidance: [
        "A deliberate stop is not a failure: the session shows as stopped, never as needing attention, and a result you were owed from it is settled silently. Pass a short reason (for example, “the user asked to stop”) so the stop is attributed in the transcript.",
      ],
    },
  },
  "sessions.rename": {
    command: "sessions.rename",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      title: trimmed(1, SESSION_TITLE_MAX_LENGTH),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Rename one explicitly targeted Project Session to a new title.",
    },
  },
  "sessions.resolve": {
    command: "sessions.resolve",
    args: Schema.Struct({
      targets: Schema.Array(
        Schema.Struct({
          kind: Schema.Literal("project"),
          sessionId: bounded(1, 256),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(10000)),
      resolved: Schema.Boolean,
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Idempotently resolve or restore explicit Project Session targets.",
      guidance: [
        `${PROJECT_TODO_AUTO_COMPLETION_RULE} Resolving all actual session associations completes linked Project Chat to-dos. Source/report links do not block completion; source-only items stay open. Restore never reopens to-dos, and marking a to-do done never resolves sessions.`,
      ],
    },
  },
  "sessions.open": {
    command: "sessions.open",
    args: SessionNavigationInput,
    scope: "global",
    discovery: sessionNavigationHelp,
  },
} as const;

export function cakeChatControlTools(): CakeControlTool[] {
  return [
    ...backendAgentTools(),
    ...backendAgentSettingsTools(),
    ...Object.values(windowControlDefinitions).map((definition) =>
      Schema.decodeUnknownSync(CakeControlTool)({
        examples: [],
        result: "A bounded authoritative Cake application result.",
        ...definition.discovery,
        command: definition.command,
        parameters: Schema.toStandardJSONSchemaV1(
          "discoveryArgs" in definition ? definition.discoveryArgs : definition.args,
        )["~standard"].jsonSchema.input({ target: "draft-07" }),
      }),
    ),
  ];
}
