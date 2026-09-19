import { Context, Schema, type Effect } from "effect";
import type {
  DrawBoardDocument,
  DrawBoardId,
  DrawBoardMetadata,
  DrawBoardTitle,
  DrawSessionId,
} from "../../domain/draw/draw-board-data";

export const DRAW_BOARD_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;

export class DrawBoardStorageError extends Schema.TaggedError<DrawBoardStorageError>()(
  "DrawBoardStorageError",
  {
    operation: Schema.String,
    code: Schema.Literals(["not-found", "revision-conflict", "snapshot-too-large", "storage"]),
    message: Schema.String,
  },
) {}

export interface DrawBoardStorageService {
  readonly list: (
    sessionId: DrawSessionId,
  ) => Effect.Effect<ReadonlyArray<DrawBoardMetadata>, DrawBoardStorageError>;
  readonly create: (
    board: DrawBoardMetadata,
  ) => Effect.Effect<DrawBoardMetadata, DrawBoardStorageError>;
  readonly read: (
    sessionId: DrawSessionId,
    boardId: DrawBoardId,
  ) => Effect.Effect<DrawBoardDocument, DrawBoardStorageError>;
  readonly save: (
    sessionId: DrawSessionId,
    boardId: DrawBoardId,
    expectedRevision: number,
    snapshot: Schema.Schema.Type<typeof Schema.Json>,
    updatedAt: string,
  ) => Effect.Effect<DrawBoardMetadata, DrawBoardStorageError>;
  readonly rename: (
    sessionId: DrawSessionId,
    boardId: DrawBoardId,
    title: DrawBoardTitle,
    updatedAt: string,
  ) => Effect.Effect<DrawBoardMetadata, DrawBoardStorageError>;
  readonly delete: (
    sessionId: DrawSessionId,
    boardId: DrawBoardId,
  ) => Effect.Effect<void, DrawBoardStorageError>;
  readonly deleteSession: (sessionId: DrawSessionId) => Effect.Effect<void, DrawBoardStorageError>;
}

export class DrawBoardStorage extends Context.Service<DrawBoardStorage, DrawBoardStorageService>()(
  "cake/services/storage/DrawBoardStorage",
) {}
