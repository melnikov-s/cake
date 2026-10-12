import { Schema } from "effect";
import { QueuedSessionCommand } from "../../contracts/conversations/session-query-data";
import type { AppControlResult } from "./app-control-data";

import { bounded, sessionIdTargetSchema } from "./control-arguments";
import { defineSessionControl } from "./control-definition";
export const sessionQueueControls = [
  defineSessionControl({
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
    run: async (input, { host }, command, known): Promise<AppControlResult> => {
      const { sessionId } = input;

      const workspacePath = known.workingDirectory;
      const target = { workspacePath, sessionId };
      return {
        ok: true,
        command,
        target,
        ...(await host.sessions.queueCommand(sessionId, input.command)),
      };
    },
  }),
  defineSessionControl({
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
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.reorderQueuedMessage(
          input.sessionId,
          input.itemId,
          input.position,
        ),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.pending",
    args: sessionIdTargetSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "List queued commands and messages with itemIds, partIds, lanes, states and positions for inspection, reordering and cancellation.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        result: await host.sessions.query(input.sessionId, { kind: "pending" }),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.dequeue",
    args: sessionIdTargetSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Clear and return all steering and follow-up messages queued in one explicitly targeted Project Session. To edit queued content, dequeue it, modify the returned text, then use sessions.send.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const { sessionId } = input;
      return {
        ok: true,
        command,
        messages: await host.sessions.dequeuePendingMessages(sessionId),
      };
    },
  }),
  defineSessionControl({
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
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.removeQueuedMessage(input.sessionId, input.partId),
      };
    },
  }),
  defineSessionControl({
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
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.steerQueuedMessage(input.sessionId, input.partId),
      };
    },
  }),
  defineSessionControl({
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
    run: async (input, { host }, command): Promise<AppControlResult> => {
      return {
        ok: true,
        command,
        messages: await host.sessions.sendQueuedMessageNow(input.sessionId, input.partId),
      };
    },
  }),
  defineSessionControl({
    command: "sessions.clear-queue",
    args: sessionIdTargetSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Clear and return all steering and follow-up messages queued in one explicitly targeted Project Session.",
    },
    run: async (input, { host }, command): Promise<AppControlResult> => {
      const { sessionId } = input;
      return {
        ok: true,
        command,
        messages: await host.sessions.dequeuePendingMessages(sessionId),
      };
    },
  }),
];
