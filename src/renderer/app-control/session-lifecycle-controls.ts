import { Effect, Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH, thinkingLevelSchema } from "../../ipc/session-contract";
import { isActiveSessionActivity } from "../lib/session-activity";
import { CakeModelSelection } from "../../ipc/cake-model-selection";
import type { AppControlResult } from "./app-control-data";
import { sessionLabels, knownSession } from "./control-projections";
import { bounded, trimmed, sessionIdTargetSchema } from "./control-arguments";
import { defineControl, defineSessionControl } from "./control-definition";
import { toStrictJson } from "./control-json";
const createSessionArgs = Schema.Struct({
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
      if (input.sessionId && !knownSession(host, input.sessionId))
        return { ok: false, command, error: "Cake could not find that session." };
      return {
        ok: true,
        command,
        messages: await host.sessions.listScheduledMessages(input.sessionId),
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
    args: sessionIdTargetSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Stop one explicitly targeted running session.",
    },
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      if (!isActiveSessionActivity(host.state.sessionActivity(sessionId)))
        return { ok: false, command, error: "That session is not currently running." };
      await host.sessions.abort(sessionId);
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
  defineSessionControl({
    command: "sessions.set-labels",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      labelIds: Schema.Array(Schema.String.check(Schema.isUUID(4))).check(
        Schema.isMaxLength(100),
        Schema.isUnique(),
      ),
    }),
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      const available = sessionLabels(host);
      const labels = input.labelIds.flatMap((labelId) => {
        const label = available.find((item) => item.id === labelId);
        return label ? [label] : [];
      });
      if (labels.length !== input.labelIds.length)
        return { ok: false, command, error: "Cake could not find a selected session label." };
      if (
        labels.some((label) => label.scope === "project" && label.projectPath !== known.projectPath)
      )
        return { ok: false, command, error: "A selected label belongs to a different Project." };
      if (!(await host.sessionLabels.setSessionLabels(sessionId, input.labelIds)))
        return { ok: false, command, error: "Cake could not update those session labels." };
      return { ok: true, command, target, labels };
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
      const projectIds = input.targets
        .filter((target) => target.kind === "project")
        .map((target) => target.sessionId);
      const unknownProject = projectIds.find((sessionId) => !knownSession(host, sessionId));
      if (unknownProject)
        return { ok: false, command, error: `Cake could not find session ${unknownProject}.` };
      const projectCount = projectIds.length
        ? await host.sessions.setProjectSessionsResolved([...new Set(projectIds)], input.resolved)
        : 0;
      return toStrictJson({
        ok: true,
        command,
        targets: input.targets,
        resolved: input.resolved,
        sessionCount: projectCount,
      });
    },
  }),
];
