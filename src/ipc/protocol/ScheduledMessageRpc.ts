import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ScheduleMessageInput,
  ScheduledMessage,
  ScheduledMessageError,
  ScheduledMessageUpdate,
} from "../../domain/scheduled-message-data";

export const ScheduledMessageRpc = RpcGroup.make(
  Rpc.make("scheduledMessages.observe", {
    payload: { targetSessionId: ScheduleMessageInput.fields.targetSessionId },
    success: ScheduledMessageUpdate,
    error: ScheduledMessageError,
    stream: true,
  }),
  Rpc.make("scheduledMessages.list", {
    payload: { targetSessionId: Schema.optionalKey(ScheduleMessageInput.fields.targetSessionId) },
    success: Schema.Array(ScheduledMessage),
    error: ScheduledMessageError,
  }),
  Rpc.make("scheduledMessages.schedule", {
    payload: ScheduleMessageInput,
    success: ScheduledMessage,
    error: ScheduledMessageError,
  }),
  Rpc.make("scheduledMessages.cancel", {
    payload: { id: ScheduledMessage.fields.id },
    error: ScheduledMessageError,
  }),
);
