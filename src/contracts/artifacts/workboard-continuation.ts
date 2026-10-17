import { Schema } from "effect";
import { BoardSequence, BoardSessionId } from "./message-board";

export const BoardContinuationInput = Schema.Struct({
  mode: Schema.Literals(["resume", "paused", "off"]),
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  topic: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))),
  awaitAuthors: Schema.optionalKey(
    Schema.Array(BoardSessionId).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  ),
  maxTurns: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(10)),
  ),
});
export interface BoardContinuationInput extends Schema.Schema.Type<typeof BoardContinuationInput> {}
export const BoardContinuation = Schema.Struct({
  recipientSessionId: BoardSessionId,
  boardId: Schema.String,
  authorizationId: Schema.String,
  mode: BoardContinuationInput.fields.mode,
  topic: BoardContinuationInput.fields.topic,
  awaitAuthors: Schema.Array(BoardSessionId),
  completedAuthors: Schema.Array(BoardSessionId),
  remainingTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pending: Schema.optionalKey(
    Schema.Struct({
      turnId: Schema.String.check(Schema.isUUID(4)),
      sequences: Schema.Array(BoardSequence).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
      through: BoardSequence,
    }),
  ),
  lastDelivery: Schema.optionalKey(
    Schema.Struct({
      turnId: Schema.String,
      status: Schema.Literals(["consumed", "canceled"]),
    }),
  ),
});
export interface BoardContinuation extends Schema.Schema.Type<typeof BoardContinuation> {}
