import { Schema } from "effect";
import {
  SessionNavigationInput,
  sessionNavigationHelp,
} from "../../contracts/application/session-navigation";
import { SessionHistoryQuery } from "../../contracts/conversations/session-query-data";
import { jsonObjectSchema } from "../../contracts/serialization/json-contract";
import type { AppControlResult } from "./app-control-data";
import {
  getAppState,
  knownSession,
  orderedFamilySessions,
  toControlSession,
} from "./control-projections";
import { bounded, sessionIdTargetSchema, emptyArgumentsSchema } from "./control-arguments";
import { defineControl, defineSessionControl } from "./control-definition";
import { toStrictJson } from "./control-json";
export const sessionInspectionControls = [
  defineControl({
    command: "sessions.list",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "List all project sessions, ordered by recency, and attention-worthy project sessions.",
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      const state = getAppState(host, source);
      return toStrictJson({
        ok: true,
        command,
        sessions: state.recentSessions,
        attentionSessions: state.attentionSessions,
      });
    },
  }),
  defineControl({
    command: "sessions.list-family",
    args: emptyArgumentsSchema,
    scope: "internal",
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session")
        return {
          ok: false,
          command,
          error: "Listing a Session Family requires a calling Project Session.",
        };
      const current = knownSession(host, source.sessionId);
      if (!current?.familyId)
        return {
          ok: false,
          command,
          error: "The calling Project Session does not belong to a Session Family.",
        };
      const sessions = orderedFamilySessions(host, current.familyId);
      const root = sessions.find((session) => session.familyDepth === 0);
      if (!root)
        return {
          ok: false,
          command,
          error: "Cake could not find the Session Family root.",
        };
      return toStrictJson({
        ok: true,
        command,
        familyId: current.familyId,
        rootSessionId: root.sessionId,
        currentSessionId: current.sessionId,
        sessions: sessions.map((session) => toControlSession(host, session)),
      });
    },
  }),
  defineSessionControl({
    command: "sessions.info",
    args: sessionIdTargetSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Inspect one explicitly targeted project session.",
      guidance: ["sessionFile is the full path to Pi's authoritative JSONL transcript."],
      result:
        "The target's metadata, full sessionFile path, firstUserMessage, selection, and activity state.",
    },
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const preview = known.draft ? undefined : await host.sessions.inspect(sessionId);
      const activity = host.state.sessionActivity(sessionId);
      const current = host.state.currentSelection();
      return {
        ok: true,
        command,
        session: {
          ...toControlSession(host, known),
          ...(preview
            ? {
                sessionFile: preview.sessionFile,
                ...(preview.firstUserMessage
                  ? { firstUserMessage: preview.firstUserMessage }
                  : null),
              }
            : null),
        },
        selected: current.kind === "project-session" && current.sessionId === sessionId,
        status: activity ?? "idle",
      };
    },
  }),
  defineSessionControl({
    command: "sessions.cake",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      command: bounded(1, 256),
      input: Schema.optionalKey(jsonObjectSchema),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Discover or invoke any Cake capability registered on the target Project Session, using that session's own authority and scope.",
      guidance: [
        "This exposes the parent's full live Cake catalog, including artifacts, browser, models, plugins, worktrees, session configuration, forks and family operations when available.",
        "Use command: help for the topic index, a topic name for its protocol, or <operation>.help for one exact schema. Then invoke that command with input containing only its operation arguments.",
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      return {
        ok: true,
        command,
        target,
        result: await host.sessions.callCakeOperation(sessionId, input.command, input.input ?? {}),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.history",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      ...SessionHistoryQuery.fields,
    }),
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const kind = "history";
      return {
        ok: true,
        command,
        target,
        result: await host.sessions.query(sessionId, { ...input, kind }),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.compactions",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      ...SessionHistoryQuery.fields,
    }),
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const kind = "compactions";
      return {
        ok: true,
        command,
        target,
        result: await host.sessions.query(sessionId, { ...input, kind }),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.tree",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      ...SessionHistoryQuery.fields,
    }),
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const kind = "tree";
      return {
        ok: true,
        command,
        target,
        result: await host.sessions.query(sessionId, { ...input, kind }),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.context",
    args: sessionIdTargetSchema,
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const kind = "context";
      return {
        ok: true,
        command,
        target,
        result: await host.sessions.query(sessionId, { ...input, kind }),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.usage",
    args: sessionIdTargetSchema,
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const kind = "usage";
      return {
        ok: true,
        command,
        target,
        result: await host.sessions.query(sessionId, { ...input, kind }),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.commands",
    args: sessionIdTargetSchema,
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const kind = "commands";
      return {
        ok: true,
        command,
        target,
        result: await host.sessions.query(sessionId, { ...input, kind }),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.open",
    args: SessionNavigationInput,
    scope: "global",
    discovery: sessionNavigationHelp,
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      if (!host.sessions.navigationEnabled())
        return {
          ok: false,
          command,
          error:
            "Agent session navigation is disabled in Settings → Agent for this window. Offer a session link for the user to open instead.",
        };
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const { messageId } = input;
      const messageFound = messageId
        ? await host.sessions.open(sessionId, messageId)
        : await host.sessions.open(sessionId);
      if (messageFound === false)
        return {
          ok: false,
          command,
          error: messageId
            ? `Cake could not find message ${messageId} in that session.`
            : "Cake could not open that session.",
        };
      return {
        ok: true,
        command,
        opened: messageId ? { ...target, messageId } : target,
      };
    },
  }),
];
