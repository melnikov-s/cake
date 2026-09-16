import { Schema } from "effect";

const queuedText = Schema.String.check(Schema.isMaxLength(262_144));

/** Transient queue state owned by a live Pi conversation runtime. */
export const PiQueuedMessages = Schema.Struct({
  steering: Schema.Array(queuedText),
  followUp: Schema.Array(queuedText),
});
export interface PiQueuedMessages extends Schema.Schema.Type<typeof PiQueuedMessages> {}

const PiPendingMessage = Schema.Struct({
  itemId: Schema.String.check(Schema.isUUID(4)),
  lane: Schema.Literals(["steering", "follow-up"]),
  position: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Literals(["queued", "compaction-held"]),
  text: queuedText,
});
/** Structured, process-lifetime view of Pi's live queue. */
export const PiPendingMessages = Schema.Struct({ items: Schema.Array(PiPendingMessage) });
export interface PiPendingMessages extends Schema.Schema.Type<typeof PiPendingMessages> {}

export const PiPendingMessageReorder = Schema.Struct({
  itemId: PiPendingMessage.fields.itemId,
  position: PiPendingMessage.fields.position,
});
export interface PiPendingMessageReorder extends Schema.Schema.Type<
  typeof PiPendingMessageReorder
> {}
