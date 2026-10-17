import { parentContinuationGuidance } from "../conversations/parent-continuation";
import { Schema } from "effect";
import { CakeControlTool } from "../cake-chats/cake-chat-data";
import { BackendAgentInvocation } from "./backend-agent-control";

/** Data-only discovery. These operations execute in the backend, never in the window gateway. */
const definitions = [
  {
    command: "settings.sections",
    scope: "global",
    discovery: {
      topic: "settings",
      summary:
        "List the Cake settings sections available to agents, including scope and writability.",
    },
  },
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
  {
    command: "projects.settings.get",
    scope: "global",
    discovery: {
      topic: "projects",
      summary: "Read every setting for one explicitly targeted Cake Project.",
    },
  },
  {
    command: "projects.settings.update",
    scope: "global",
    discovery: {
      topic: "projects",
      summary:
        "Patch any setting for one explicitly targeted Cake Project and return all committed settings.",
      guidance: [
        "Call projects.settings.get before updating the Project. Unspecified settings remain unchanged.",
      ],
      examples: [
        {
          input: {
            projectPath: "/path/to/project",
            changes: {
              worktreeSetupCommands: "ln -s /path/to/project/node_modules node_modules",
            },
          },
        },
      ],
    },
  },
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
      summary: "List a bounded session roster, newest first.",
      guidance: [
        "Use projectPath, title query, status or attentionOnly to narrow results before offset/limit pagination (default 20, maximum 50).",
        "launchedByCakeChat: true selects your unresolved launches. Status is selection metadata; sessions.info supplies full metadata, deep links and the latest report. Never poll to wait for completion.",
      ],
      result:
        "Session references, titles, kind, project name and status, with total and nextOffset (null at the end).",
      examples: [
        {
          input: {},
        },
        {
          input: {
            launchedByCakeChat: true,
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
      guidance: ["sessionFile is the full path to Pi's authoritative JSONL transcript."],
      result:
        "The target's metadata, ready-made full-UUID deepLink (cake://session/<uuid>; use it verbatim for user links), full sessionFile path, firstUserMessage, and backend activity state. Window selection is available through app.state.",
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
    command: "sessions.send",
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Send, queue, or steer a correlated message to one explicitly targeted session. The result is a visible delivery receipt; optional maxMessages bounds the exchange.",
      guidance: [
        "sessionId is required from Cake Chat; Cake Chat cannot message itself. Project Sessions reach Cake Chat by omitting sessionId.",
        "From a Project Session: expectsResponse defaults to false. Set true only when you need an answer (an assignment, question, or blocker); the recipient then owes exactly one result, or one failure/stopped notice if the turn handling this message ends without one. With false, the recipient never reports back automatically.",
        'From Cake Chat: report replaces expectsResponse. "digest" (default) owes one result that arrives quietly as a status line on the user\'s next message (a blocked report arrives right away); "interrupt" delivers it immediately and starts a turn, only when the user asked to hear back right away; "silent" owes nothing. expectsResponse: false means silent.',
        parentContinuationGuidance,
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
