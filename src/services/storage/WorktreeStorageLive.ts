import { readFile } from "node:fs/promises";
import { Effect, Layer, Schema } from "effect";
import { WorktreeRecord } from "../../domain/managed-worktree-data";
import { AtomicFileWriter } from "./internal/AtomicFileWriter";
import {
  WorktreeStorage,
  WorktreeStorageError,
  type WorktreeStorageRepository,
} from "./WorktreeStorage";

const storedWorktrees = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
  records: Schema.Array(WorktreeRecord)
    .check(Schema.isMaxLength(500))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

const storageError = (operation: string, cause: unknown) =>
  new WorktreeStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeWorktreeStorageLive = (storagePath: string): Layer.Layer<WorktreeStorage> => {
  const writer = new AtomicFileWriter();
  const repository: WorktreeStorageRepository = {
    load: async () => {
      try {
        const raw = await readFile(storagePath, "utf8");
        return [...Schema.decodeUnknownSync(storedWorktrees)(JSON.parse(raw)).records];
      } catch {
        // Missing or malformed legacy storage is treated as an empty catalog.
        return [];
      }
    },
    save: async (records) => {
      const document: typeof storedWorktrees.Type = {
        schemaVersion: 1,
        records: [...records],
      };
      await writer.write(storagePath, JSON.stringify(document, null, 2));
    },
  };

  const service = WorktreeStorage.of({
    load: Effect.fn("WorktreeStorage.load")(() =>
      Effect.tryPromise({
        try: repository.load,
        catch: (cause) => storageError("WorktreeStorage.load", cause),
      }),
    ),
    save: Effect.fn("WorktreeStorage.save")((records) =>
      Effect.tryPromise({
        try: () => repository.save(records),
        catch: (cause) => storageError("WorktreeStorage.save", cause),
      }),
    ),
  });

  return Layer.succeed(WorktreeStorage, service);
};
