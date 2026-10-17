import { Schema } from "effect";
import {
  AgentScheduledListInput,
  AgentScheduledReadInput,
} from "../../contracts/scheduled-messages/agent-scheduled-messages";

import { type JsonObject } from "../../contracts/serialization/json-contract";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

export function createScheduledMessageOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  const invokeAppControl =
    (command: string): CakeOperationDefinition["execute"] =>
    (input, context) => {
      // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
      return api().invokeAppControl(command, input as JsonObject, context.signal);
    };
  return [
    {
      command: "sessions.schedule",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Schedule a message to an explicitly targeted Project Session at an ISO timestamp.",
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
        sendAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      }),
      examples: [
        {
          input: {
            sessionId: "target-session-id",
            text: "Check the build result.",
            sendAt: "2030-01-01T12:00:00.000Z",
          },
        },
      ],
      result:
        "Scheduled message ID, destination, send time and confirmation; no repeated message body.",
      execute: invokeAppControl("sessions.schedule"),
    },
    {
      command: "sessions.scheduled",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "List durable scheduled messages, optionally for one Project Session.",
      inputSchema: AgentScheduledListInput,
      examples: [{}],
      result:
        "Bounded IDs, destinations, short labels and send times, total and nextOffset; sessions.scheduled-info reads one exact message.",
      execute: invokeAppControl("sessions.scheduled"),
    },
    {
      command: "sessions.scheduled-info",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Read one exact scheduled message in bounded text slices.",
      inputSchema: AgentScheduledReadInput,
      examples: [],
      result:
        "Message metadata and text (4000 characters by default, max 20000), totalChars and nextOffset.",
      execute: invokeAppControl("sessions.scheduled-info"),
    },
    {
      command: "sessions.cancel-scheduled",
      requires: "invokeAppControl",
      topic: "sessions",
      summary: "Cancel one scheduled message by ID.",
      inputSchema: Schema.Struct({
        id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
      examples: [{ input: { id: "scheduled-message-id" } }],
      result: "A cancellation status.",
      execute: invokeAppControl("sessions.cancel-scheduled"),
    },
  ];
}
