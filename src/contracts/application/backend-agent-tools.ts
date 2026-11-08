import { sessionParentGuidance } from "../project-sessions/session-reference";
import { sessionMessageDeliveryGuidance } from "../conversations/session-message-delivery";
import { promptFilesGuidance } from "../conversations/prompt-files";
import { sessionCompactionDefinitions } from "../project-sessions/session-compaction";
import { resultDeliveryGuidance } from "../conversations/result-delivery";
import { compactDiscoveryGuidance } from "../agent/discovery-result-text";
import { sessionListGuidance, sessionListResult } from "../project-sessions/agent-session-list";
import { Schema } from "effect";
import { CakeControlTool } from "../cake-chats/cake-chat-data";
import { BackendAgentInvocation } from "./backend-agent-control";
import { automationToolDescriptions } from "../automations/agent-automations";
import {
  agentScheduleGuidance,
  agentScheduleSummary,
} from "../scheduled-messages/agent-scheduled-messages";

/** Data-only discovery. These operations execute in the backend, never in the window gateway. */
const definitions = [
  ...automationToolDescriptions.map(({ command, summary, result }) => ({
    command,
    scope: "global",
    discovery: {
      topic: "automations",
      summary,
      result,
      guidance: ["automations.list", "automations.history"].includes(command)
        ? [compactDiscoveryGuidance]
        : [],
    },
  })),
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
      summary: "List session labels",
    },
  },
  {
    command: "session-labels.add",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Add session label",
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
      summary: "Rename/recolor label",
    },
  },
  {
    command: "session-labels.remove",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Delete label and assignments",
    },
  },
  {
    command: "session-labels.reorder",
    scope: "global",
    discovery: {
      topic: "session-labels",
      summary: "Reorder label (zero-based)",
    },
  },
  {
    command: "sessions.list",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "List non-resolved sessions and project identity",
      guidance: sessionListGuidance,
      result: sessionListResult,
      examples: [
        {
          input: {},
        },
        {
          input: {
            projection: "workflow",
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
      summary: "Inspect target metadata",
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
      summary: "Call target's scoped Cake capability",
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
      summary: "Search/read session history",
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
      summary: "Inspect compaction metadata",
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
      summary: "Inspect history branches",
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
      summary: "Inspect target context usage",
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
      summary: "Read target usage/cost",
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
      summary: "List queueable commands",
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
      summary: "List pending report obligations",
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
      summary: "Read pending report slice",
    },
  },
  {
    command: "sessions.reports.acknowledge",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Attest visible report handling",
      guidance: [
        "Emit visible notice first; acknowledge IDs with exact communicatedText, never planned/unrelated prose. Dismiss only by user decision. Evidence is visible text, not automatic semantic judgment.",
      ],
    },
  },
  {
    command: "sessions.completions",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "List pending completion decisions",
      guidance: [
        "Up to 50 pending/deferred items for this caller. Notifications batch passively; reply queues continuation without duplicate notice. Completion is not mutation/merge approval.",
      ],
    },
  },
  {
    command: "sessions.completions.update",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Record user decision; no lifecycle action",
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
      summary: "Message target; omission reaches Cake Chat",
      guidance: [
        "projects.list returns projectChatId; send directly. No checkout/hash/history lookup. Receipt proves admission/retention, not execution.",
        "sessionId is required from Cake Chat; Cake Chat cannot message itself. Project Sessions reach global Cake Chat by omitting sessionId.",
        sessionParentGuidance,
        "A resolved self-target (including Cake Chat parent) cannot create a messaging thread; it does not auto-forward.",
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
      summary: "Reply in current exchange",
      guidance: [promptFilesGuidance],
    },
  },
  {
    command: "sessions.thread",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Inspect current exchange",
    },
  },
  {
    command: "sessions.close-thread",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Close current exchange",
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
      summary: "List scheduled messages",
    },
  },
  {
    command: "sessions.scheduled-info",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Read scheduled message",
    },
  },
  {
    command: "sessions.cancel-scheduled",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Cancel scheduled message",
    },
  },
  {
    command: "sessions.set-labels",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Replace labels; first is primary",
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
