import { Schema } from "effect";

import { type JsonObject } from "../../contracts/serialization/json-contract";

import type { RuntimeOperationApi } from "../../services/pi/runtime/cake-operation-providers";
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";

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
      result: "The durable scheduled message and its ID.",
      execute: invokeAppControl("sessions.schedule"),
    },
    {
      command: "sessions.scheduled",
      topic: "sessions",
      summary: "List durable scheduled messages, optionally for one Project Session.",
      inputSchema: Schema.Struct({
        sessionId: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        ),
      }),
      examples: [{}],
      result: "Scheduled message IDs, destinations, text, and send times.",
      execute: invokeAppControl("sessions.scheduled"),
    },
    {
      command: "sessions.cancel-scheduled",
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
