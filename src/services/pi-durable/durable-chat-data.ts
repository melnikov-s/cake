import { Schema } from "effect";

export class DurableChatError extends Schema.TaggedError<DurableChatError>()("DurableChatError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const DurableChatMemoryView = Schema.Struct({
  text: Schema.String,
  bytes: Schema.Int,
  sourceCount: Schema.Int,
  partCount: Schema.Int,
});
export interface DurableChatMemoryView extends Schema.Schema.Type<typeof DurableChatMemoryView> {}
