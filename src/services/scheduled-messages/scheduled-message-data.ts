import { Schema } from "effect";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const isoTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);

/** Cake-owned intent waiting to become an ordinary Pi user message. */
export const ScheduledMessage = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  targetSessionId: boundedId,
  text: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  sendAt: isoTimestamp,
  createdAt: isoTimestamp,
  createdBySessionId: Schema.optionalKey(boundedId),
});
export interface ScheduledMessage extends Schema.Schema.Type<typeof ScheduledMessage> {}

export const ScheduledMessageSnapshot = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  messages: Schema.Array(ScheduledMessage).check(Schema.isMaxLength(10_000)),
});
export interface ScheduledMessageSnapshot extends Schema.Schema.Type<
  typeof ScheduledMessageSnapshot
> {}

const ScheduledMessageEvent = Schema.TaggedUnion({
  Upserted: { message: ScheduledMessage },
  Removed: { id: ScheduledMessage.fields.id },
});
export const ScheduledMessageUpdate = Schema.TaggedUnion({
  Snapshot: { revision: Schema.Int, messages: Schema.Array(ScheduledMessage) },
  Event: { revision: Schema.Int, event: ScheduledMessageEvent },
});
export type ScheduledMessageUpdate = Schema.Schema.Type<typeof ScheduledMessageUpdate>;

export const ScheduleMessageInput = Schema.Struct({
  targetSessionId: boundedId,
  text: ScheduledMessage.fields.text,
  sendAt: isoTimestamp,
  createdBySessionId: Schema.optionalKey(boundedId),
});
export interface ScheduleMessageInput extends Schema.Schema.Type<typeof ScheduleMessageInput> {}

export class ScheduledMessageError extends Schema.TaggedError<ScheduledMessageError>()(
  "ScheduledMessageError",
  { operation: Schema.String, message: Schema.String },
) {}
