import { Schema } from "effect";

/** Display-only projection of the engine's FIFO; never an admission authority. */
export const LandingQueueWait = Schema.Struct({
  operationId: Schema.String,
  blockingOperationId: Schema.String,
  position: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  queuedAt: Schema.Number,
});
export interface LandingQueueWait extends Schema.Schema.Type<typeof LandingQueueWait> {}
