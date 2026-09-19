import { DateTime, Effect } from "effect";
import {
  DrawBoardStorage,
  type DrawBoardStorageError,
} from "../../services/storage/DrawBoardStorage";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  DrawBoardError,
  DrawBoardId,
  type DrawBoardCreateInput,
  type DrawBoardListInput,
  type DrawBoardRenameInput,
  type DrawBoardSaveInput,
  type DrawBoardTarget,
  type DrawSessionId,
} from "./draw-board-data";

const asDrawBoardError = (error: DrawBoardStorageError) =>
  new DrawBoardError({
    operation: error.operation,
    code: error.code,
    message: error.message,
  });

const assertMutable = Effect.fn("DrawBoards.assertMutable")(function* (
  operation: string,
  sessionId: DrawSessionId,
) {
  const family = yield* (yield* SessionFamilyStorage)
    .familyForMember(sessionId)
    .pipe(
      Effect.mapError(
        (error) => new DrawBoardError({ operation, code: "storage", message: error.message }),
      ),
    );
  const resolved = yield* (yield* SessionArchiveStorage)
    .resolvedProjectEntry(family?.parentSessionId ?? sessionId)
    .pipe(
      Effect.mapError(
        (error) => new DrawBoardError({ operation, code: "storage", message: error.message }),
      ),
    );
  if (resolved)
    return yield* new DrawBoardError({
      operation,
      code: "read-only",
      message: "Boards belonging to resolved sessions are read-only",
    });
});

export const list = Effect.fn("DrawBoards.list")(function* (input: DrawBoardListInput) {
  return yield* (yield* DrawBoardStorage)
    .list(input.sessionId)
    .pipe(Effect.mapError(asDrawBoardError));
});

export const create = Effect.fn("DrawBoards.create")(function* (input: DrawBoardCreateInput) {
  yield* assertMutable("create", input.sessionId);
  const now = DateTime.formatIso(yield* DateTime.now);
  return yield* (yield* DrawBoardStorage)
    .create({
      id: DrawBoardId.make(crypto.randomUUID()),
      sessionId: input.sessionId,
      title: input.title,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    .pipe(Effect.mapError(asDrawBoardError));
});

export const read = Effect.fn("DrawBoards.read")(function* (input: DrawBoardTarget) {
  return yield* (yield* DrawBoardStorage)
    .read(input.sessionId, input.boardId)
    .pipe(Effect.mapError(asDrawBoardError));
});

export const save = Effect.fn("DrawBoards.save")(function* (input: DrawBoardSaveInput) {
  yield* assertMutable("save", input.sessionId);
  const now = DateTime.formatIso(yield* DateTime.now);
  return yield* (yield* DrawBoardStorage)
    .save(input.sessionId, input.boardId, input.expectedRevision, input.snapshot, now)
    .pipe(Effect.mapError(asDrawBoardError));
});

export const rename = Effect.fn("DrawBoards.rename")(function* (input: DrawBoardRenameInput) {
  yield* assertMutable("rename", input.sessionId);
  const now = DateTime.formatIso(yield* DateTime.now);
  return yield* (yield* DrawBoardStorage)
    .rename(input.sessionId, input.boardId, input.title, now)
    .pipe(Effect.mapError(asDrawBoardError));
});

export const deleteBoard = Effect.fn("DrawBoards.delete")(function* (input: DrawBoardTarget) {
  yield* assertMutable("delete", input.sessionId);
  yield* (yield* DrawBoardStorage)
    .delete(input.sessionId, input.boardId)
    .pipe(Effect.mapError(asDrawBoardError));
});

export const deleteSession = Effect.fn("DrawBoards.deleteSession")(function* (
  sessionId: DrawSessionId,
) {
  yield* (yield* DrawBoardStorage).deleteSession(sessionId).pipe(Effect.mapError(asDrawBoardError));
});
