import { Schema } from "effect";

export const BoardSessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const BoardSequence = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const BoardAudience = Schema.Union([
  Schema.Literal("workgroup"),
  Schema.Array(BoardSessionId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
]);
export const BoardAppendInput = Schema.Struct({
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  audience: Schema.optionalKey(BoardAudience),
});
export interface BoardAppendInput extends Schema.Schema.Type<typeof BoardAppendInput> {}
export const BoardEntry = Schema.Struct({
  sequence: BoardSequence,
  authorSessionId: BoardSessionId,
  createdAt: Schema.String,
  description: BoardAppendInput.fields.description,
  body: BoardAppendInput.fields.body,
  audience: BoardAudience,
});
export interface BoardEntry extends Schema.Schema.Type<typeof BoardEntry> {}
export const BoardDescription = Schema.Struct({
  sequence: BoardSequence,
  authorSessionId: BoardSessionId,
  createdAt: Schema.String,
  description: BoardAppendInput.fields.description,
  audience: BoardAudience,
});
export interface BoardDescription extends Schema.Schema.Type<typeof BoardDescription> {}
export const BoardReceipt = Schema.Struct({
  sequence: BoardSequence,
  sessionId: BoardSessionId,
  notifiedAt: Schema.optionalKey(Schema.String),
  readAt: Schema.optionalKey(Schema.String),
});
export interface BoardReceipt extends Schema.Schema.Type<typeof BoardReceipt> {}
export const BoardEntryReceipts = Schema.Struct({
  entry: BoardDescription,
  receipts: Schema.Array(BoardReceipt),
});
export interface BoardEntryReceipts extends Schema.Schema.Type<typeof BoardEntryReceipts> {}
export const BoardPageInput = Schema.Struct({
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
  ),
});
export interface BoardPageInput extends Schema.Schema.Type<typeof BoardPageInput> {}
export const BoardBrowseInput = Schema.Struct({
  ...BoardPageInput.fields,
  recent: Schema.optionalKey(Schema.Boolean),
});
export interface BoardBrowseInput extends Schema.Schema.Type<typeof BoardBrowseInput> {}
export const BoardDescriptionPage = Schema.Struct({
  boardId: Schema.String,
  entries: Schema.Array(BoardDescription),
  nextAfter: Schema.Int,
  hasMore: Schema.Boolean,
});
export interface BoardDescriptionPage extends Schema.Schema.Type<typeof BoardDescriptionPage> {}
export const BoardReadInput = Schema.Struct({
  sequences: Schema.Array(BoardSequence).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});
export const BoardReadResult = Schema.Struct({
  boardId: Schema.String,
  entries: Schema.Array(BoardEntry),
});
export interface BoardReadResult extends Schema.Schema.Type<typeof BoardReadResult> {}
export const BoardSessionReceipts = Schema.Struct({
  boardId: Schema.String,
  sessionId: BoardSessionId,
  entries: Schema.Array(Schema.Struct({ entry: BoardDescription, receipt: BoardReceipt })),
  nextAfter: Schema.Int,
  hasMore: Schema.Boolean,
});
export interface BoardSessionReceipts extends Schema.Schema.Type<typeof BoardSessionReceipts> {}

export class MessageBoardError extends Schema.TaggedError<MessageBoardError>()(
  "MessageBoardError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export const boardRelevant = (entry: BoardDescription, sessionId: string) =>
  entry.audience === "workgroup" || entry.audience.includes(sessionId);
export const boardDescription = (entry: BoardEntry): BoardDescription => ({
  sequence: entry.sequence,
  authorSessionId: entry.authorSessionId,
  createdAt: entry.createdAt,
  description: entry.description,
  audience: entry.audience,
});
