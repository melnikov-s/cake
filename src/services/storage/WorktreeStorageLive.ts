import { Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import { atomicWriteFile } from "./internal/atomicFile";
import { WorktreeStorage, WorktreeStorageError } from "./WorktreeStorage";

const StoredWorktrees = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  records: Schema.Array(WorktreeRecord)
    .check(Schema.isMaxLength(500))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const storageError = (operation: string, cause: unknown) =>
  new WorktreeStorageError({ operation, message: messageOf(cause) });

/** Effect-native, serialized and atomically replaced Managed Worktree storage. */
export const makeWorktreeStorageLive = (
  storagePath: string,
): Layer.Layer<WorktreeStorage, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    WorktreeStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);

      const loadUnlocked = Effect.fn("WorktreeStorage.load")(function* () {
        const exists = yield* fileSystem
          .exists(storagePath)
          .pipe(Effect.mapError((cause) => storageError("WorktreeStorage.load", cause)));
        if (!exists) return [];
        const text = yield* fileSystem
          .readFileString(storagePath)
          .pipe(Effect.mapError((cause) => storageError("WorktreeStorage.load", cause)));
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredWorktrees))(text).pipe(
          Effect.map((document) => [...document.records]),
          // Preserve the established recovery policy for malformed legacy storage.
          Effect.catch(() => Effect.succeed([])),
        );
      });

      const saveUnlocked = Effect.fn("WorktreeStorage.save")(function* (
        records: ReadonlyArray<WorktreeRecord>,
      ) {
        const encoded = yield* Schema.encodeEffect(StoredWorktrees)({
          schemaVersion: 1,
          records: [...records],
        }).pipe(Effect.mapError((cause) => storageError("WorktreeStorage.save", cause)));
        const content = yield* Effect.try({
          try: () => JSON.stringify(encoded, null, 2),
          catch: (cause) => storageError("WorktreeStorage.save", cause),
        });
        yield* atomicWriteFile(fileSystem, path, storagePath, content, (_stage, cause) =>
          storageError("WorktreeStorage.save", cause),
        );
      });

      return WorktreeStorage.of({
        load: () => lock.withPermits(1)(loadUnlocked()),
        save: (records) => lock.withPermits(1)(saveUnlocked(records)),
      });
    }),
  );
