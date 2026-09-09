import { Stream } from "effect";
import * as scheduledMessages from "../../domain/scheduled-messages/scheduledMessages";
import { ScheduledMessageRpc } from "../protocol/ScheduledMessageRpc";

export const scheduledMessageHandlers = ScheduledMessageRpc.of({
  "scheduledMessages.observe": ({ targetSessionId }) =>
    Stream.unwrap(scheduledMessages.observe(targetSessionId)),
  "scheduledMessages.list": ({ targetSessionId }) => scheduledMessages.list(targetSessionId),
  "scheduledMessages.schedule": (input) => scheduledMessages.schedule(input),
  "scheduledMessages.cancel": ({ id }) => scheduledMessages.cancel(id),
});
