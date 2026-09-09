import { Schema } from "effect";

const queuedText = Schema.String.check(Schema.isMaxLength(262_144));

/** Transient queue state owned by a live Pi conversation runtime. */
export const PiQueuedMessages = Schema.Struct({
  steering: Schema.Array(queuedText),
  followUp: Schema.Array(queuedText),
});
export interface PiQueuedMessages extends Schema.Schema.Type<typeof PiQueuedMessages> {}
