import { sessionMessageDeliveryGuidance } from "../conversations/session-message-delivery";
import { promptFilesGuidance } from "../conversations/prompt-files";
import { sessionCompactionDefinitions } from "../project-sessions/session-compaction";
import { resultDeliveryGuidance } from "../conversations/result-delivery";
import { compactDiscoveryGuidance } from "../agent/discovery-result-text";
import { sessionListGuidance, sessionListResult } from "../project-sessions/agent-session-list";
import { Schema } from "effect";
import { CakeControlTool } from "../cake-chats/cake-chat-data";
import { BackendAgentInvocation } from "./backend-agent-control";
import {
  agentScheduleGuidance,
  agentScheduleSummary,
} from "../scheduled-messages/agent-scheduled-messages";

/** Data-only discovery. These operations execute in the backend, never in the window gateway. */
const definitions = [
  ...sessionCompactionDefinitions.map(
    ({ command, topic, summary, guidance, examples, result }) => ({
      command,
      scope: "global",
      discovery: { topic, summary, guidance, examples, result },
    }),
  ),
  { command: "projects.list", scope: "internal" },
  { command: "projects.info", scope: "internal" },
  {
    command: "project.settings.get",
    scope: "internal",
  },
  {
    command: "project.settings.update",
    scope: "internal",
  },
  // Cake Chat owns the strictly typed operations (cake-chat-project-operations.ts).
  { command: "projects.settings.get", scope: "internal" },
  { command: "projects.settings.update", scope: "internal" },
  {
    command: "session-labels.list",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "List global and project-specific labels that can be assigned to Project Sessions.",
    },
  },
  {
    command: "session-labels.add",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Add a global or project-specific session label.",
      guidance: ["Omit projectPath to create a global label available in every Project."],
      examples: [
        {
          input: {
            name: "In review",
            color: "cyan",
          },
        },
        {
          input: {
            name: "Ready to deploy",
            color: "green",
            projectPath: "/path/to/project",
          },
          description: "Create a project-specific label.",
        },
      ],
    },
  },
  {
    command: "session-labels.update",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Rename or recolor an existing session label.",
    },
  },
  {
    command: "session-labels.remove",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Remove a session label and clear it from every session that uses it.",
    },
  },
  {
    command: "session-labels.reorder",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Move a global or project-specific label to a new zero-based position.",
    },
  },
  {
    command: "sessions.list",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "List sessions with context/cache hints, or invoking-chat launches grouped by workflow.",
      guidance: sessionListGuidance,
      result: sessionListResult,
      examples: [
        {
          input: {},
        },
        {
          input: {
            projection: "workflow",
            includeResolved: true,
          },
        },
      ],
    },
  },
  {
    command: "sessions.info",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Inspect one explicitly targeted project session.",
      guidance: [
        "Metadata only: no transcript, first input, attachment content, or report summary. Use explicit scoped history/messages/attachments operations for content.",
      ],
      result:
        "Compact identity/deepLink, workspace, effective resolved lifecycle and separate execution outcome/activity. No transcript/runtime inspection.",
    },
  },
  {
    command: "sessions.cake",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Discover or invoke any Cake capability registered on the target Project Session, using that session's own authority and scope.",
      guidance: [
        "This exposes the parent's full live Cake catalog, including artifacts, browser, models, plugins, worktrees, session configuration, forks and family operations when available.",
        "Use command: help for topics, a topic for operation summaries, or <operation>.help directly for an exact input contract. Invoke with operation arguments in input; <operation>.output-schema opts into the full result schema.",
        "Singular session.*, context.* and other session-scoped operations apply to the targeted parent, never to the assistant's side chat. Do not claim success without checking the operation result.",
      ],
      examples: [
        {
          input: {
            sessionId: "parent-session-id",
            command: "help",
          },
        },
      ],
    },
  },
  {
    command: "sessions.history",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Read or search authoritative session history. Combine text, entry type, role, tool name, time and branch filters; results are paginated and clipped.",
      guidance: [
        "For the session assistant, this session means the attached parent Project Session, not the assistant side chat.",
        "History defaults to the active branch; compactions and tree default to all branches. Use leafId for a particular branch, or branch: all for the full tree.",
        "Filters are combined with AND; entries are chronological. offset/limit paginate matched entries; truncated indicates clipped evidence.",
      ],
    },
  },
  {
    command: "sessions.compactions",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Inspect normal and tool compactions, including inactive branches and source-branch references. active distinguishes current-branch compaction from historical compaction.",
      guidance: [
        "For the session assistant, this session means the attached parent Project Session, not the assistant side chat.",
        "History defaults to the active branch; compactions and tree default to all branches. Use leafId for a particular branch, or branch: all for the full tree.",
        "Filters are combined with AND; entries are chronological. offset/limit paginate matched entries; truncated indicates clipped evidence.",
      ],
    },
  },
  {
    command: "sessions.tree",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Inspect session-tree entries and branch relationships, including the active branch. Results are paginated.",
      guidance: [
        "For the session assistant, this session means the attached parent Project Session, not the assistant side chat.",
        "History defaults to the active branch; compactions and tree default to all branches. Use leafId for a particular branch, or branch: all for the full tree.",
        "Filters are combined with AND; entries are chronological. offset/limit paginate matched entries; truncated indicates clipped evidence.",
      ],
    },
  },
  {
    command: "sessions.context",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Inspect the target session's context use, limit and remaining capacity.",
      guidance: [
        "For the session assistant, this session means the attached parent Project Session, not the assistant side chat.",
        "History defaults to the active branch; compactions and tree default to all branches. Use leafId for a particular branch, or branch: all for the full tree.",
        "Filters are combined with AND; entries are chronological. offset/limit paginate matched entries; truncated indicates clipped evidence.",
      ],
    },
  },
  {
    command: "sessions.usage",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Inspect provider-reported tokens and cost for the target session.",
      guidance: [
        "For the session assistant, this session means the attached parent Project Session, not the assistant side chat.",
        "History defaults to the active branch; compactions and tree default to all branches. Use leafId for a particular branch, or branch: all for the full tree.",
        "Filters are combined with AND; entries are chronological. offset/limit paginate matched entries; truncated indicates clipped evidence.",
      ],
    },
  },
  {
    command: "sessions.commands",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "List the target session's slash commands and whether each can be queued.",
      guidance: [
        "For the session assistant, this session means the attached parent Project Session, not the assistant side chat.",
        "History defaults to the active branch; compactions and tree default to all branches. Use leafId for a particular branch, or branch: all for the full tree.",
        "Filters are combined with AND; entries are chronological. offset/limit paginate matched entries; truncated indicates clipped evidence.",
      ],
    },
  },
  {
    command: "sessions.reports",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Page pending user-facing report obligations; admission is not communication.",
      guidance: [compactDiscoveryGuidance],
      result:
        "Compact pending report ID/admissions/session/handle/status/task rows; report bodies require sessions.reports.read.",
    },
  },
  {
    command: "sessions.reports.read",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Read a bounded pending report slice with provenance; reading does not handle it.",
    },
  },
  {
    command: "sessions.reports.acknowledge",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Attest explicit report handling using exact assistant text already emitted to the user.",
      guidance: [
        "Emit a concise grouped notice first, then acknowledge its IDs with exact communicatedText. Never acknowledge a future final answer or an unrelated reply. Dismiss only on the user's explicit decision. Visible text evidence is checked, semantic communication is an agent attestation, not automatically inferred.",
      ],
    },
  },
  {
    command: "sessions.completions",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Inspect your quiet completion inbox and outstanding review/merge/resolve/next-step decisions, without waking work.",
      guidance: [
        "Returns at most fifty pending/deferred items scoped to this requesting conversation. The application displays notification-mode result links with the next user message or the batched turn that delivers them when the user is idle; delivered notices do not repeat. Reply-mode results start/queue a turn without a second quiet notification. Completion is never permission to mutate or merge.",
      ],
    },
  },
  {
    command: "sessions.completions.update",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Record a user's completion decision as deferred, handled or dismissed; this never performs review, merge or resolution.",
      guidance: [
        "Use after the user makes or defers a decision. Do not mark handled merely because a session finished or its notice was shown. This changes only inbox metadata and never rearms a notification.",
      ],
    },
  },
  {
    command: "sessions.send",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Send, queue, or steer a correlated message to one explicitly targeted session. The result is an admission/retention receipt; optional maxMessages bounds the exchange.",
      guidance: [
        "For a registered Project Chat, call projects.list with query and pass its canonical projectChatId as sessionId. Do not read repository files, hash paths, or inspect recipient history to find its address. The receipt confirms admission/deferred retention, not recipient execution or completion.",
        "sessionId is required from Cake Chat; Cake Chat cannot message itself. Project Sessions reach global Cake Chat by omitting sessionId.",
        promptFilesGuidance,
        resultDeliveryGuidance,
        sessionMessageDeliveryGuidance,
      ],
    },
  },
  {
    command: "sessions.reply",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Reply to the originating session in the current open coordination thread without supplying a session ID.",
      guidance: [promptFilesGuidance],
    },
  },
  {
    command: "sessions.thread",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Inspect the current coordination thread, correlated messages, delivery states, participants, and optional message limit.",
    },
  },
  {
    command: "sessions.close-thread",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Close the current coordination thread. Further replies are rejected; late arrivals remain attributed to the closed exchange.",
    },
  },
  {
    command: "sessions.schedule",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: agentScheduleSummary,
      guidance: agentScheduleGuidance,
      examples: [
        { input: { text: "Check the PR status.", repeatEverySeconds: 180 } },
        { input: { text: "Remind me to review the build.", delaySeconds: 15 } },
      ],
    },
  },
  {
    command: "sessions.scheduled",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "List bounded scheduled-message IDs, destinations, send times, repeat intervals and short labels; filter session/query before offset/limit pagination.",
    },
  },
  {
    command: "sessions.scheduled-info",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Read one scheduled message by exact ID in bounded text slices (maxChars up to 20000).",
    },
  },
  {
    command: "sessions.cancel-scheduled",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Cancel one scheduled or recurring message by its ID.",
    },
  },
  {
    command: "sessions.set-labels",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Replace the ordered labels on one Project Session. The first label is primary.",
      guidance: [
        "Call session-labels.list to discover label IDs available to the target session.",
        "Pass an empty labelIds array to clear all labels.",
      ],
      examples: [
        {
          input: {
            sessionId: "target-session-id",
            labelIds: ["00000000-0000-4000-8000-000000000001"],
          },
        },
        {
          input: {
            sessionId: "target-session-id",
            labelIds: [],
          },
          description: "Clear all labels.",
        },
      ],
    },
  },
  {
    command: "sessions.list-family",
    scope: "internal",
  },
] as const;

export function backendAgentTools() {
  return definitions.flatMap((definition) => {
    if (!("discovery" in definition)) return [];
    const schema = BackendAgentInvocation.members.find((member) =>
      Schema.is(member.fields.name)(definition.command),
    );
    if (!schema) throw new Error(`Missing backend control schema: ${definition.command}`);
    return [
      Schema.decodeUnknownSync(CakeControlTool)({
        examples: [],
        result: "A bounded authoritative Cake application result.",
        ...definition.discovery,
        command: definition.command,
        parameters: Schema.toStandardJSONSchemaV1(schema.fields.arguments)[
          "~standard"
        ].jsonSchema.input({ target: "draft-07" }),
      }),
    ];
  });
}
