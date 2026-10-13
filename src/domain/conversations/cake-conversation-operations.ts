import { Schema } from "effect";
import {
  SessionNavigationInput,
  sessionNavigationHelp,
} from "../../contracts/application/session-navigation";
import { CakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import { jsonObjectSchema, type JsonObject } from "../../contracts/serialization/json-contract";

import { SESSION_TITLE_MAX_LENGTH } from "../../contracts/conversations/session-contract";
import {
  SessionHistoryQuery,
  QueuedSessionCommand,
} from "../../contracts/conversations/session-query-data";

import { PiPendingMessageReorder } from "../../contracts/conversations/pending-message-data";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

export function createConversationOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  const empty = Schema.Struct({});
  const invokeAppControl =
    (command: string): CakeOperationDefinition["execute"] =>
    (input, context) => {
      // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
      return api().invokeAppControl(command, input as JsonObject, context.signal);
    };
  return [
    {
      command: "session.info",
      topic: "sessions",
      summary:
        "Return identity, transcript location, initial request, workspace, resolution, and model information for the calling session.",
      guidance: [
        "Singular session.* operations always target the calling session and never accept a sessionId.",
        "sessionFile is the full path to Pi's authoritative JSONL transcript.",
      ],
      inputSchema: empty,
      examples: [{}],
      result:
        "The session identity, title, full sessionFile path, firstUserMessage, workspacePath, resolution state, and provider/model/reasoning.",
      execute: async () => api().info(),
    },
    {
      command: "session.rename",
      topic: "sessions",
      summary: "Rename the calling session.",
      guidance: [
        "Singular session.* operations always target the calling session and never accept a sessionId.",
      ],
      inputSchema: Schema.Struct({
        title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
      }),
      examples: [{ input: { title: "Authentication refactor" } }],
      result: "The calling session ID and committed title.",
      execute: (input) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().rename((input as { title: string }).title);
      },
    },
    {
      command: "sessions.list",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "List Project Sessions across all registered Cake projects.",
      guidance: [
        "Use sessions.list-family when only the calling Project Session's family is needed.",
      ],
      inputSchema: empty,
      examples: [{}],
      result:
        "Project Session identities, projects, paths, titles, activity, and resolution state.",
      execute: (_input, context) => api().invokeAppControl("sessions.list", {}, context.signal),
    },
    {
      command: "sessions.open",
      requires: "invokeAppControl",
      ...sessionNavigationHelp,
      inputSchema: SessionNavigationInput,
      execute: invokeAppControl("sessions.open"),
    },
    {
      command: "sessions.cake",
      requires: "invokeAppControl",
      topic: "sessions",
      summary:
        "Discover or invoke any Cake capability registered on a target Project Session, in that session's own scope.",
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        input: Schema.optionalKey(jsonObjectSchema),
      }),
      guidance: [
        "Use command: help for the target's topic index, a topic name for its protocol, or <operation>.help for an exact schema, then invoke it with operation arguments in input.",
        "Singular session.* and context.* operations act on the target, not the caller. A session assistant uses its attached parent's ID.",
      ],
      examples: [{ input: { sessionId: "target-session-id", command: "help" } }],
      result: "The parent-scoped Cake operation's result or protocol.",
      execute: invokeAppControl("sessions.cake"),
    },
    ...(["history", "compactions", "tree", "context", "usage", "commands"] as const).map(
      (kind): CakeOperationDefinition => ({
        command: `sessions.${kind}`,
        requires: "invokeAppControl",
        topic: "sessions",
        summary:
          kind === "history"
            ? "Read or search authoritative session history with combined text, type, role, tool, time and branch filters."
            : kind === "compactions"
              ? "Inspect normal and tool compactions across all branches; active identifies current-branch compactions."
              : kind === "tree"
                ? "Inspect paginated session-tree entries and branch relationships."
                : kind === "commands"
                  ? "List available slash commands and their queueability."
                  : `Inspect the target session's ${kind}.`,
        guidance: [
          "Supply the target Project Session ID. A session assistant targets its parent, not its own side chat.",
          "History defaults to the active branch; compactions and tree default to all branches. leafId selects an exact branch; it cannot be combined with branch: all.",
          "Filters combine with AND before pagination. Entries are chronological; nextOffset continues the result. truncated indicates clipped evidence.",
        ],
        inputSchema:
          kind === "history" || kind === "compactions" || kind === "tree"
            ? Schema.Struct({
                sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
                ...SessionHistoryQuery.fields,
              })
            : Schema.Struct({
                sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
              }),
        examples: [{ input: { sessionId: "target-session-id" } }],
        result: "A bounded authoritative session query result.",
        execute: invokeAppControl(`sessions.${kind}`),
      }),
    ),
    {
      command: "sessions.queue-command",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Queue a slash command between responses without interrupting the active response.",
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ...QueuedSessionCommand.fields,
      }),
      guidance: [
        "Inspect sessions.commands for queueable commands. /compact accepts instructions; /toolcompact takes no arguments and uses the latest completed assistant response when executed.",
        "Commands preserve follow-up queue order. Inspect, reorder or cancel through sessions.pending, sessions.reorder and sessions.cancel-queued. Commands cannot be steered.",
        "Acceptance is not completion. Pending commands live only for the runtime's lifetime.",
      ],
      examples: [{ input: { sessionId: "target-session-id", command: "/toolcompact" } }],
      result: "A queued receipt with a stable itemId.",
      execute: invokeAppControl("sessions.queue-command"),
    },
    {
      command: "sessions.info",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Inspect one explicitly targeted Project Session.",
      guidance: ["sessionFile is the full path to Pi's authoritative JSONL transcript."],
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
      examples: [{ input: { sessionId: "target-session-id" } }],
      result:
        "The target's metadata, full sessionFile path, firstUserMessage, selection, and activity state.",
      execute: invokeAppControl("sessions.info"),
    },
    {
      command: "sessions.pending",
      requires: "pendingMessages",
      topic: "sessions",
      summary: "List the live pending inputs for an explicitly targeted Project Session.",
      guidance: [
        "Items have stable process-lifetime itemIds and projected partIds for cancel-queued, steer-queued, and send-now. position is one-based within the named lane.",
        "Cross-session items expose plain message text plus crossSession routing and sender metadata; they do not expose transcript or tool history.",
        "The steering lane redirects an active turn at Pi's next steering boundary; follow-up starts after the active turn settles.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
      examples: [{ input: { sessionId: "target-session-id" } }],
      result: "The target session's ordered steering and follow-up queue items.",
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry decoded input with this operation's schema.
        const { sessionId } = input as { sessionId: string };
        return api().pendingMessages(sessionId, context.signal);
      },
    },
    {
      command: "sessions.reorder",
      requires: "reorderPendingMessage",
      topic: "sessions",
      summary: "Move one live pending input to an exact one-based position in its queue lane.",
      guidance: [
        "Call sessions.pending first and pass its itemId. Positions are one-based and interpreted within the item's existing lane after removing it.",
        "Reordering never changes delivery semantics. Use the separate steering capability when an item should redirect active work.",
        "User and agent-sent inputs share the same ordering policy. Either can be moved within steering or follow-up; sender identity never sets priority.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ...PiPendingMessageReorder.fields,
      }),
      examples: [
        {
          input: {
            sessionId: "target-session-id",
            itemId: "00000000-0000-4000-8000-000000000000",
            position: 1,
          },
        },
      ],
      result: "The target session's updated pending queue with authoritative lane positions.",
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry decoded input with this operation's schema.
        const { sessionId, ...reorder } = input as {
          sessionId: string;
          itemId: string;
          position: number;
        };
        return api().reorderPendingMessage(sessionId, reorder, context.signal);
      },
    },
    ...(["sessions.cancel-queued", "sessions.steer-queued", "sessions.send-now"] as const).map(
      (command): CakeOperationDefinition => ({
        command,
        requires: "invokeAppControl",
        topic: "sessions",
        summary:
          command === "sessions.cancel-queued"
            ? "Cancel one queued input in a targeted Project Session."
            : command === "sessions.steer-queued"
              ? "Append one queued follow-up input to the steering lane, preserving existing steering order."
              : "Stop the active turn and send one queued input now; preserve the remaining queue.",
        guidance: [
          "Call sessions.pending first and pass the item's partId (not its itemId).",
          "These operations apply equally to user and agent-sent messages. Cancellation removes only the selected message, including pending steering; send-now bypasses both lanes.",
        ],
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          partId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        }),
        examples: [{ input: { sessionId: "child-session-id", partId: "queued-follow-up-...-1" } }],
        result: "The target's remaining steering and follow-up queues.",
        execute: invokeAppControl(command),
      }),
    ),
    {
      command: "sessions.clear-queue",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Clear all steering and follow-up inputs queued in a targeted Project Session.",
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
      examples: [{ input: { sessionId: "child-session-id" } }],
      result: "The removed steering and follow-up queues.",
      execute: invokeAppControl("sessions.clear-queue"),
    },
    {
      command: "sessions.abort",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Stop the active turn in an explicitly targeted Project Session.",
      guidance: [
        "Use this to stop a running child or other Project Session without resolving or deleting it; the session remains available for later messages.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
      examples: [{ input: { sessionId: "target-session-id" } }],
      result: "A confirmed stopping status, or an error when the target is not running.",
      execute: invokeAppControl("sessions.abort"),
    },
    {
      command: "sessions.rename",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Rename an explicitly targeted Project Session in any Cake project.",
      guidance: [
        "Use session.rename for the calling session. Use sessions.rename with a sessionId from sessions.list or a child creation result to rename any other Project Session, whether idle or running.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        title: Schema.Trim.pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH)),
        ),
      }),
      examples: [{ input: { sessionId: "target-session-id", title: "Storage implementation" } }],
      result: "The target session identity and its committed title.",
      execute: invokeAppControl("sessions.rename"),
    },
    {
      command: "sessions.set-labels",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Replace the ordered labels on one Project Session. The first label is primary.",
      guidance: [
        "Call session-labels.list to discover label IDs available to the target session.",
        "Pass an empty labelIds array to clear all labels.",
      ],
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        labelIds: Schema.Array(Schema.String.check(Schema.isUUID(4))).check(
          Schema.isMaxLength(100),
          Schema.isUnique(),
        ),
      }),
      examples: [
        {
          input: {
            sessionId: "target-session-id",
            labelIds: ["00000000-0000-4000-8000-000000000001"],
          },
        },
        {
          input: { sessionId: "target-session-id", labelIds: [] },
          description: "Clear all labels.",
        },
      ],
      result: "The target session and its committed ordered labels.",
      execute: invokeAppControl("sessions.set-labels"),
    },
    {
      command: "sessions.compact",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Compact an explicitly targeted Project Session.",
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
      }),
      examples: [{ input: { sessionId: "target-session-id" } }],
      result: "A completed compaction status.",
      execute: invokeAppControl("sessions.compact"),
    },
    {
      command: "session.usage",
      topic: "sessions",
      summary: "Return normalized provider-reported token usage and cost for the calling session.",
      guidance: ["Usage is advisory and is not a hard spending-limit mechanism."],
      inputSchema: empty,
      examples: [{}],
      result: "Normalized token counts, reported cost in USD, and honest pricing coverage.",
      execute: async () => api().usage(),
    },
    {
      command: "session.set-model",
      topic: "sessions",
      summary:
        "Set the calling session's model from a configured preset or explicit configuration.",
      guidance: [
        "Singular session.* operations always target the calling session and never accept a sessionId.",
      ],
      inputSchema: Schema.Struct({ model: CakeModelSelection }),
      examples: [
        {
          input: { model: "Sol" },
          description: "Select a configured preset by name.",
        },
      ],
      result: "The committed provider, model ID, thinking level, and Fast mode setting.",
      execute: (input) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().setModel((input as { model: CakeModelSelection }).model);
      },
    },
    {
      command: "context.status",
      topic: "context",
      summary: "Inspect estimated current context use through Pi's public usage facilities.",
      inputSchema: empty,
      examples: [{}],
      result:
        "tokens, limit, remaining, utilization, and measurement; unavailable estimates remain null rather than appearing as zero.",
      execute: async () => api().contextStatus(),
    },
    {
      command: "context.compact",
      topic: "context",
      summary: "Invoke Pi's normal compaction mechanism for the calling session.",
      inputSchema: Schema.Struct({
        instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
      }),
      examples: [
        {
          input: { instructions: "Preserve implementation decisions and pending verification." },
        },
      ],
      result: "A completed compaction status.",
      limitations: ["Cake does not create a separate summary or transcript representation."],
      execute: (input) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().compact((input as { instructions?: string }).instructions);
      },
    },
  ];
}
