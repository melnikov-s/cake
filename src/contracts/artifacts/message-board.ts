import { Schema } from "effect";
import { BoardDelivery } from "./board-delivery";

export const BoardSessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const BoardSequence = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const BoardAudience = Schema.Union([
  Schema.Literal("workgroup"),
  Schema.Array(BoardSessionId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
]);
const BoardTopic = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
const BoardRelations = {
  topic: Schema.optionalKey(BoardTopic),
  supersedes: Schema.optionalKey(
    Schema.Array(BoardSequence).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  ),
};
const BoardEvent = Schema.Literals(["assignment", "completion", "blocker"]);
export const BoardAppendInput = Schema.Struct({
  requestId: Schema.optionalKey(BoardSessionId),
  event: Schema.optionalKey(BoardEvent),
  resultKind: Schema.optionalKey(Schema.Literals(["ready", "investigation"])),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
  audience: BoardAudience,
  ...BoardRelations,
});
export interface BoardAppendInput extends Schema.Schema.Type<typeof BoardAppendInput> {}
export const BoardEntry = Schema.Struct({
  requestId: BoardAppendInput.fields.requestId,
  sequence: BoardSequence,
  authorSessionId: BoardSessionId,
  createdAt: Schema.String,
  description: BoardAppendInput.fields.description,
  body: BoardAppendInput.fields.body,
  event: BoardAppendInput.fields.event,
  resultKind: BoardAppendInput.fields.resultKind,
  audience: BoardAudience,
  ...BoardRelations,
});
export interface BoardEntry extends Schema.Schema.Type<typeof BoardEntry> {}
export const BoardDescription = Schema.Struct({
  sequence: BoardSequence,
  authorSessionId: BoardSessionId,
  createdAt: Schema.String,
  description: BoardAppendInput.fields.description,
  event: BoardAppendInput.fields.event,
  resultKind: BoardAppendInput.fields.resultKind,
  audience: BoardAudience,
  ...BoardRelations,
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
  deliveries: Schema.optionalKey(Schema.Array(BoardDelivery)),
});
export interface BoardEntryReceipts extends Schema.Schema.Type<typeof BoardEntryReceipts> {}
export const BoardPageInput = Schema.Struct({
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
  ),
});
export interface BoardPageInput extends Schema.Schema.Type<typeof BoardPageInput> {}
export const BoardCurrentInput = Schema.Struct({
  ...BoardPageInput.fields,
  topic: Schema.optionalKey(BoardTopic),
});
export interface BoardCurrentInput extends Schema.Schema.Type<typeof BoardCurrentInput> {}
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

/** Only the family root receives broadcasts automatically; explicit audiences route other members. */
export const boardDeliveryRelevant = (
  entry: BoardDescription,
  sessionId: string,
  rootSessionId: string,
) =>
  entry.authorSessionId !== sessionId &&
  (sessionId === rootSessionId ||
    (entry.audience !== "workgroup" && entry.audience.includes(sessionId)));

export const boardRelevant = (entry: BoardDescription, sessionId: string) =>
  entry.audience === "workgroup" || entry.audience.includes(sessionId);
export const boardDescription = (entry: BoardEntry): BoardDescription => {
  const description = {
    sequence: entry.sequence,
    authorSessionId: entry.authorSessionId,
    createdAt: entry.createdAt,
    description: entry.description,
    audience: entry.audience,
  };
  if (entry.event !== undefined) Object.assign(description, { event: entry.event });
  if (entry.resultKind !== undefined) Object.assign(description, { resultKind: entry.resultKind });
  if (entry.topic !== undefined) Object.assign(description, { topic: entry.topic });
  if (entry.supersedes !== undefined) Object.assign(description, { supersedes: entry.supersedes });
  return description;
};

/** Audience is routing, not privacy. A targeted replacement only supersedes for its recipients. */
export const boardCurrentEntries = <T extends BoardDescription>(
  entries: ReadonlyArray<T>,
  sessionId: string,
): ReadonlyArray<T> => {
  const relevant = entries.filter((entry) => boardRelevant(entry, sessionId));
  const superseded = new Set(relevant.flatMap((entry) => entry.supersedes ?? []));
  return relevant.filter((entry) => !superseded.has(entry.sequence));
};
