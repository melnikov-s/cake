import { Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import {
  DrawBoardDocument,
  DrawBoardMetadata,
  type DrawBoardId,
  type DrawBoardTitle,
  type DrawSessionId,
} from "../../domain/draw/draw-board-data";
import {
  DRAW_BOARD_SNAPSHOT_MAX_BYTES,
  DrawBoardStorage,
  DrawBoardStorageError,
} from "./DrawBoardStorage";
import { atomicWriteFile } from "./internal/atomicFile";

const DOCUMENT_VERSION = 1;
const CatalogDocument = Schema.Struct({
  version: Schema.Literal(DOCUMENT_VERSION),
  boards: Schema.Array(DrawBoardMetadata).check(Schema.isMaxLength(10_000)),
});
const BoardDocument = Schema.Struct({
  version: Schema.Literal(DOCUMENT_VERSION),
  data: DrawBoardDocument,
});

const storageError = (
  operation: string,
  cause: unknown,
  code: DrawBoardStorageError["code"] = "storage",
) =>
  new DrawBoardStorageError({
    operation,
    code,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const notFound = (operation: string, boardId: string) =>
  storageError(operation, `Draw board ${boardId} was not found for that session`, "not-found");

export const makeDrawBoardStorageLive = (root: string) =>
  Layer.effect(
    DrawBoardStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const catalogPath = path.join(root, "catalog.json");
      const boardDirectory = path.join(root, "boards");
      const boardPath = (boardId: DrawBoardId) => path.join(boardDirectory, `${boardId}.json`);

      const readText = (operation: string, target: string) =>
        fileSystem
          .readFileString(target)
          .pipe(Effect.mapError((cause) => storageError(operation, cause)));

      const writeText = (operation: string, target: string, content: string) =>
        atomicWriteFile(fileSystem, path, target, content, (stage, cause) =>
          storageError(`${operation}:${stage}`, cause),
        );

      const loadCatalogUnlocked = Effect.fn("DrawBoardStorage.loadCatalogUnlocked")(function* () {
        const exists = yield* fileSystem
          .exists(catalogPath)
          .pipe(Effect.mapError((cause) => storageError("list", cause)));
        if (!exists) return [];
        const document = yield* readText("list", catalogPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogDocument))),
          Effect.mapError((cause) => storageError("decodeCatalog", cause)),
        );
        const ids = new Set<string>();
        for (const board of document.boards) {
          if (ids.has(board.id))
            return yield* storageError(
              "decodeCatalog",
              `Duplicate draw board metadata for ${board.id}`,
            );
          ids.add(board.id);
        }
        return document.boards;
      });

      const saveCatalogUnlocked = Effect.fn("DrawBoardStorage.saveCatalogUnlocked")(function* (
        boards: ReadonlyArray<DrawBoardMetadata>,
      ) {
        const encoded = yield* Schema.encodeEffect(CatalogDocument)({
          version: DOCUMENT_VERSION,
          boards,
        }).pipe(Effect.mapError((cause) => storageError("encodeCatalog", cause)));
        yield* writeText("saveCatalog", catalogPath, `${JSON.stringify(encoded, null, 2)}\n`);
      });

      const readBoardUnlocked = Effect.fn("DrawBoardStorage.readBoardUnlocked")(function* (
        board: DrawBoardMetadata,
      ) {
        const document = yield* readText("read", boardPath(board.id)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(BoardDocument))),
          Effect.mapError((cause) => storageError("decodeBoard", cause)),
        );
        const stored = document.data.board;
        if (
          stored.id !== board.id ||
          stored.sessionId !== board.sessionId ||
          stored.title !== board.title ||
          stored.revision !== board.revision ||
          stored.createdAt !== board.createdAt ||
          stored.updatedAt !== board.updatedAt
        )
          return yield* storageError("read", `Draw board metadata is inconsistent for ${board.id}`);
        return document.data;
      });

      const writeBoardUnlocked = Effect.fn("DrawBoardStorage.writeBoardUnlocked")(function* (
        document: DrawBoardDocument,
      ) {
        const encoded = yield* Schema.encodeEffect(BoardDocument)({
          version: DOCUMENT_VERSION,
          data: document,
        }).pipe(Effect.mapError((cause) => storageError("encodeBoard", cause)));
        yield* writeText(
          "writeBoard",
          boardPath(document.board.id),
          `${JSON.stringify(encoded)}\n`,
        );
      });

      const findBoard = (
        operation: string,
        boards: ReadonlyArray<DrawBoardMetadata>,
        sessionId: DrawSessionId,
        boardId: DrawBoardId,
      ) => {
        const board = boards.find(
          (candidate) => candidate.id === boardId && candidate.sessionId === sessionId,
        );
        return board ? Effect.succeed(board) : Effect.fail(notFound(operation, boardId));
      };

      const publishOrRollback = Effect.fn("DrawBoardStorage.publishOrRollback")(function* (
        operation: string,
        publish: Effect.Effect<void, DrawBoardStorageError>,
        rollback: Effect.Effect<void, DrawBoardStorageError>,
      ) {
        const publication = yield* Effect.result(publish);
        if (publication._tag === "Success") return;
        const restoration = yield* Effect.result(rollback);
        if (restoration._tag === "Failure")
          return yield* storageError(
            `${operation}:rollback`,
            `Catalog publication failed: ${publication.failure.message}; rollback failed: ${restoration.failure.message}`,
          );
        return yield* publication.failure;
      });

      const list = Effect.fn("DrawBoardStorage.list")(function* (sessionId: DrawSessionId) {
        return yield* lock.withPermits(1)(
          Effect.map(loadCatalogUnlocked(), (boards) =>
            boards
              .filter((board) => board.sessionId === sessionId)
              .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
          ),
        );
      });

      const create = Effect.fn("DrawBoardStorage.create")(function* (board: DrawBoardMetadata) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const boards = yield* loadCatalogUnlocked();
            if (boards.some((candidate) => candidate.id === board.id))
              return yield* storageError("create", `Draw board ${board.id} already exists`);
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* writeBoardUnlocked({ board, snapshot: null });
                yield* publishOrRollback(
                  "create",
                  saveCatalogUnlocked([...boards, board]),
                  fileSystem
                    .remove(boardPath(board.id), { force: true })
                    .pipe(Effect.mapError((cause) => storageError("create:rollback", cause))),
                );
              }),
            );
            return board;
          }),
        );
      });

      const read = Effect.fn("DrawBoardStorage.read")(function* (
        sessionId: DrawSessionId,
        boardId: DrawBoardId,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const boards = yield* loadCatalogUnlocked();
            const board = yield* findBoard("read", boards, sessionId, boardId);
            return yield* readBoardUnlocked(board);
          }),
        );
      });

      const save = Effect.fn("DrawBoardStorage.save")(function* (
        sessionId: DrawSessionId,
        boardId: DrawBoardId,
        expectedRevision: number,
        snapshot: Schema.Schema.Type<typeof Schema.Json>,
        updatedAt: string,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const serializedSnapshot = yield* Effect.try({
              try: () => JSON.stringify(snapshot),
              catch: (cause) => storageError("save", cause),
            });
            if (Buffer.byteLength(serializedSnapshot, "utf8") > DRAW_BOARD_SNAPSHOT_MAX_BYTES)
              return yield* storageError(
                "save",
                `Draw board snapshots may not exceed ${DRAW_BOARD_SNAPSHOT_MAX_BYTES} bytes`,
                "snapshot-too-large",
              );
            const boards = yield* loadCatalogUnlocked();
            const current = yield* findBoard("save", boards, sessionId, boardId);
            if (current.revision !== expectedRevision)
              return yield* storageError(
                "save",
                `Expected draw board revision ${expectedRevision}, but the current revision is ${current.revision}`,
                "revision-conflict",
              );
            const document = yield* readBoardUnlocked(current);
            const board = { ...current, revision: current.revision + 1, updatedAt };
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* writeBoardUnlocked({ board, snapshot });
                yield* publishOrRollback(
                  "save",
                  saveCatalogUnlocked(
                    boards.map((candidate) => (candidate.id === boardId ? board : candidate)),
                  ),
                  writeBoardUnlocked(document),
                );
              }),
            );
            return board;
          }),
        );
      });

      const rename = Effect.fn("DrawBoardStorage.rename")(function* (
        sessionId: DrawSessionId,
        boardId: DrawBoardId,
        title: DrawBoardTitle,
        updatedAt: string,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const boards = yield* loadCatalogUnlocked();
            const current = yield* findBoard("rename", boards, sessionId, boardId);
            const document = yield* readBoardUnlocked(current);
            const board = { ...current, title, updatedAt };
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* writeBoardUnlocked({ board, snapshot: document.snapshot });
                yield* publishOrRollback(
                  "rename",
                  saveCatalogUnlocked(
                    boards.map((candidate) => (candidate.id === boardId ? board : candidate)),
                  ),
                  writeBoardUnlocked(document),
                );
              }),
            );
            return board;
          }),
        );
      });

      const deleteBoard = Effect.fn("DrawBoardStorage.delete")(function* (
        sessionId: DrawSessionId,
        boardId: DrawBoardId,
      ) {
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const boards = yield* loadCatalogUnlocked();
            yield* findBoard("delete", boards, sessionId, boardId);
            yield* saveCatalogUnlocked(boards.filter((candidate) => candidate.id !== boardId));
            yield* fileSystem
              .remove(boardPath(boardId), { force: true })
              .pipe(Effect.mapError((cause) => storageError("delete", cause)));
          }),
        );
      });

      const deleteSession = Effect.fn("DrawBoardStorage.deleteSession")(function* (
        sessionId: DrawSessionId,
      ) {
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const boards = yield* loadCatalogUnlocked();
            const removed = boards.filter((board) => board.sessionId === sessionId);
            if (removed.length === 0) return;
            yield* saveCatalogUnlocked(boards.filter((board) => board.sessionId !== sessionId));
            yield* Effect.forEach(
              removed,
              (board) =>
                fileSystem
                  .remove(boardPath(board.id), { force: true })
                  .pipe(Effect.mapError((cause) => storageError("deleteSession", cause))),
              { discard: true },
            );
          }),
        );
      });

      return DrawBoardStorage.of({
        list,
        create,
        read,
        save,
        rename,
        delete: deleteBoard,
        deleteSession,
      });
    }),
  );
