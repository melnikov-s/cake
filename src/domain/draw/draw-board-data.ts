import { Schema } from "effect";

export const DrawBoardId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export type DrawBoardId = typeof DrawBoardId.Type;

export const DrawSessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export type DrawSessionId = typeof DrawSessionId.Type;

export const DrawBoardTitle = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);
export type DrawBoardTitle = typeof DrawBoardTitle.Type;

export const DrawBoardMetadata = Schema.Struct({
  id: DrawBoardId,
  sessionId: DrawSessionId,
  title: DrawBoardTitle,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export interface DrawBoardMetadata extends Schema.Schema.Type<typeof DrawBoardMetadata> {}

export const DrawBoardDocument = Schema.Struct({
  board: DrawBoardMetadata,
  snapshot: Schema.NullOr(Schema.Json),
});
export interface DrawBoardDocument extends Schema.Schema.Type<typeof DrawBoardDocument> {}

export const DrawBoardListInput = Schema.Struct({ sessionId: DrawSessionId });
export interface DrawBoardListInput extends Schema.Schema.Type<typeof DrawBoardListInput> {}

export const DrawBoardCreateInput = Schema.Struct({
  sessionId: DrawSessionId,
  title: DrawBoardTitle,
});
export interface DrawBoardCreateInput extends Schema.Schema.Type<typeof DrawBoardCreateInput> {}

export const DrawBoardTarget = Schema.Struct({
  sessionId: DrawSessionId,
  boardId: DrawBoardId,
});
export interface DrawBoardTarget extends Schema.Schema.Type<typeof DrawBoardTarget> {}

export const DrawBoardSaveInput = Schema.Struct({
  ...DrawBoardTarget.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  snapshot: Schema.Json,
});
export interface DrawBoardSaveInput extends Schema.Schema.Type<typeof DrawBoardSaveInput> {}

export const DrawBoardRenameInput = Schema.Struct({
  ...DrawBoardTarget.fields,
  title: DrawBoardTitle,
});
export interface DrawBoardRenameInput extends Schema.Schema.Type<typeof DrawBoardRenameInput> {}

export class DrawBoardError extends Schema.TaggedError<DrawBoardError>()("DrawBoardError", {
  operation: Schema.String,
  code: Schema.Literals([
    "not-found",
    "read-only",
    "revision-conflict",
    "snapshot-too-large",
    "storage",
  ]),
  message: Schema.String,
}) {}
