import { Schema } from "effect";

/** Execution handoff metadata, independent of body read receipts or task completion. */
export const BoardDelivery = Schema.Struct({
  boardId: Schema.String,
  sequences: Schema.Array(Schema.Int).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  through: Schema.Int,
  recipientSessionId: Schema.String,
  turnId: Schema.String.check(Schema.isUUID(4)),
  status: Schema.Literals([
    "pending",
    "deferred",
    "admitted",
    "notified",
    "consumed",
    "canceled",
    "failed",
  ]),
  issue: Schema.optionalKey(Schema.String),
});
export interface BoardDelivery extends Schema.Schema.Type<typeof BoardDelivery> {}
