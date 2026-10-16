import { Effect, Schema } from "effect";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import { messageRefsSchema } from "../../contracts/conversations/message-reference";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import {
  SESSION_TITLE_MAX_LENGTH,
  thinkingLevelSchema,
} from "../../contracts/conversations/session-contract";
import type { TurnStop } from "../../contracts/conversations/turn-stop";
import { isActiveSessionActivity } from "../lib/session-activity";
import { CakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import { CakeChatReportPolicy } from "../../contracts/project-sessions/session-reporting";
import type { AppControlResult } from "./app-control-data";

import { bounded, trimmed, sessionIdTargetSchema } from "./control-arguments";
import { defineControl, defineSessionControl } from "./control-definition";
import { toStrictJson } from "./control-json";
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
  report: Schema.optionalKey(CakeChatReportPolicy),
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
export const sessionLifecycleControls = [
  defineControl({
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
        'report decides how the initial assignment\'s one result comes back. "digest" (default) never starts a Cake Chat turn: a one-line status is attached to the user\'s next message, and a blocked report is delivered right away. "interrupt" delivers the result immediately and starts a turn; use it only when the user asked to hear back as soon as it finishes. "silent" owes no result; check on demand with sessions.list { launchedByCakeChat: true }. Later turns the user starts directly in that session never report back.',
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
    run: async (input, { host }, command): Promise<AppControlResult> => {
      if (!host.state.projects().some((project) => project.path === input.workspacePath))
        return { ok: false, command, error: "Cake could not find that project." };
      const created = await host.sessions.create(input);
      const result: Extract<
        AppControlResult,
        {
          ok: true;
          command: "sessions.create";
        }
      > = {
        ok: true,
        command,
        workspacePath: created.workspacePath,
        sessionId: created.sessionId,
        title: input.name,
        status: "started",
      };
      if (created.managedWorktree) result.managedWorktree = created.managedWorktree;
      return result;
    },
  }),
  defineControl({
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
    run: async (input, { host }, command): Promise<AppControlResult> => {
      if (!host.state.projects().some((project) => project.path === input.workspacePath))
        return { ok: false, command, error: "Cake could not find that project." };
      const created = await host.sessions.createDraft(input);
      return {
        ok: true,
        command,
        workspacePath: created.workspacePath,
        sessionId: created.sessionId,
        title: input.name,
        status: "saved-draft",
      };
    },
  }),
  defineSessionControl({
    command: "sessions.compact",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262144))),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Compact one explicitly targeted Project Session through Pi's normal compaction mechanism.",
    },
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      await host.sessions.compact(sessionId, input.instructions);
      return { ok: true, command, target, status: "compacted" };
    },
  }),
  defineSessionControl({
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const scheduledMessage = await host.sessions.scheduleMessage({
        targetSessionId: sessionId,
        text: input.text,
        sendAt: input.sendAt,
      });
      return {
        ok: true,
        command,
        target,
        scheduledMessage,
        status: "scheduled",
      };
    },
  }),
  defineControl({
    command: "sessions.scheduled",
    args: Schema.Struct({
      sessionId: Schema.optionalKey(bounded(1, 256)),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "List scheduled messages, optionally filtered to one Project Session.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      let sessionId = input.sessionId;
      if (sessionId !== undefined) {
        const resolved = resolveSessionReference(
          sessionId,
          host.state.sessions().map((session) => session.sessionId),
        );
        if (!resolved.ok) return { ok: false, command, error: resolved.error };
        sessionId = resolved.sessionId;
      }
      return {
        ok: true,
        command,
        messages: await host.sessions.listScheduledMessages(sessionId),
      };
    },
  }),
  defineControl({
    command: "sessions.cancel-scheduled",
    args: Schema.Struct({ id: bounded(1, 256) }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Cancel one scheduled message by its ID.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      await host.sessions.cancelScheduledMessage(input.id);
      return {
        ok: true,
        command,
        id: input.id,
        status: "cancelled",
      };
    },
  }),
  defineSessionControl({
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
    run: async (input, { host, source }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;
      const reason = input.reason ? { reason: input.reason } : null;
      const stop: TurnStop = source
        ? { by: "session", sessionId: source.sessionId, title: source.title, ...reason }
        : { by: "user", ...reason };

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      if (!isActiveSessionActivity(host.state.sessionActivity(sessionId)))
        return { ok: false, command, error: "That session is not currently running." };
      await host.sessions.abort(sessionId, stop);
      return { ok: true, command, target, status: "stopping" };
    },
  }),
  defineSessionControl({
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      await host.sessions.rename(sessionId, input.title);
      return { ok: true, command, target, title: input.title };
    },
  }),

  defineControl({
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
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const ids = host.state.sessions().map((session) => session.sessionId);
      const projectIds: string[] = [];
      for (const target of input.targets) {
        const resolved = resolveSessionReference(target.sessionId, ids);
        if (!resolved.ok) return { ok: false, command, error: resolved.error };
        projectIds.push(resolved.sessionId);
      }
      const projectCount = projectIds.length
        ? await host.sessions.setProjectSessionsResolved([...new Set(projectIds)], input.resolved)
        : 0;
      return toStrictJson({
        ok: true,
        command,
        targets: projectIds.map((sessionId) => ({ kind: "project", sessionId })),
        resolved: input.resolved,
        sessionCount: projectCount,
      });
    },
  }),
];
