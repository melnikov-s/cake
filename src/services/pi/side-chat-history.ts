import { Schema } from "effect";
import { attachmentSchema } from "../../contracts/conversations/session-contract";

/** Service-to-service historical dialogue, never an executable input. */
export const SideChatHistoryMessage = Schema.Struct({
  sourceEntryId: Schema.NonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  timestamp: Schema.Number,
  content: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("image"),
        data: Schema.String,
        mimeType: Schema.String,
      }),
    ]),
  ),
  attachments: Schema.Array(attachmentSchema),
  markdown: Schema.Boolean,
});
export interface SideChatHistoryMessage extends Schema.Schema.Type<typeof SideChatHistoryMessage> {}

export const SideChatHistory = Schema.Struct({
  sourceSessionId: Schema.NonEmptyString,
  inputReferenceIds: Schema.Array(Schema.String),
  messages: Schema.Array(SideChatHistoryMessage),
});
export interface SideChatHistory extends Schema.Schema.Type<typeof SideChatHistory> {}

export const SideChatHistoryImport = Schema.Struct({
  ...SideChatHistory.fields,
  threadId: Schema.NonEmptyString,
  title: Schema.String,
});
export interface SideChatHistoryImport extends Schema.Schema.Type<typeof SideChatHistoryImport> {}

export function sideChatInputReferenceIds(messages: readonly SideChatHistoryMessage[]): string[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.attachments.flatMap((attachment) => {
          if (attachment.kind === "input") return [attachment.id];
          return "inputReference" in attachment && attachment.inputReference
            ? [attachment.inputReference.id]
            : [];
        }),
      ),
    ),
  ];
}
