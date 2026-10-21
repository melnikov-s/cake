import { Schema } from "effect";

/** Application provenance, supplied by admission code, never inferred from message text. */
export const InternalInput = Schema.TaggedUnion({
  WorkboardDelivery: {
    boardId: Schema.String,
    sequences: Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))),
  },
});
export interface InternalInput extends Schema.Schema.Type<typeof InternalInput> {}
