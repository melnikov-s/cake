import { createHash } from "node:crypto";
import { Effect, FileSystem, Option, Path, Ref, Semaphore } from "effect";
import { atomicWriteFile } from "./atomicFile";
import { timedStorageRead } from "./timedStorageRead";

export const recoveryRecordFileName = (id: string) =>
  `${createHash("sha256").update(id).digest("hex")}.json`;

/** One backend owns these recovery documents. A committed record is authoritative
 * process state, not a TTL cache: failed writes never replace it. Each mutation
 * encodes/replaces one record, independent of the number of historical sessions. */
export const makeRecoveryRecordFiles = Effect.fn("RecoveryRecordFiles.make")(function* <
  A,
  E,
>(options: {
  readonly directory: string;
  readonly idOf: (record: A) => string;
  readonly decode: (content: string) => Effect.Effect<A, unknown>;
  readonly encode: (record: A) => Effect.Effect<string, unknown>;
  readonly onError: (operation: string, file: string, cause: unknown) => E;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const committed = new Map<string, Option.Option<A>>();
  const loaded = yield* Ref.make(false);
  const fileFor = (id: string) => path.join(options.directory, recoveryRecordFileName(id));
  const failure = (operation: string, file: string) => (cause: unknown) =>
    options.onError(operation, file, cause);

  const read = Effect.fn("RecoveryRecordFiles.read")(function* (file: string) {
    const existing = committed.get(file);
    if (existing !== undefined) return existing;
    if (!(yield* fs.exists(file).pipe(Effect.mapError(failure("read", file))))) {
      committed.set(file, Option.none());
      return Option.none<A>();
    }
    const content = yield* fs.readFileString(file).pipe(Effect.mapError(failure("read", file)));
    const record = yield* options.decode(content).pipe(Effect.mapError(failure("decode", file)));
    if (fileFor(options.idOf(record)) !== file)
      return yield* Effect.fail(
        options.onError("decode", file, "Record identity does not match its filename"),
      );
    const value = Option.some(record);
    committed.set(file, value);
    return value;
  });
  const get = Effect.fn("RecoveryRecordFiles.get")((id: string) =>
    timedStorageRead(
      "RecoveryRecordFiles.get",
      lock,
      read(fileFor(id)).pipe(Effect.map(Option.getOrUndefined)),
    ),
  );
  const list = Effect.fn("RecoveryRecordFiles.list")(() =>
    lock.withPermit(
      Effect.gen(function* () {
        if (!(yield* Ref.get(loaded))) {
          if (
            yield* fs
              .exists(options.directory)
              .pipe(Effect.mapError(failure("read", options.directory)))
          ) {
            const files = yield* fs
              .readDirectory(options.directory)
              .pipe(Effect.mapError(failure("read", options.directory)));
            for (const file of files) {
              if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
              yield* read(path.join(options.directory, file));
            }
          }
          yield* Ref.set(loaded, true);
        }
        return [...committed.values()].flatMap((value) =>
          Option.isSome(value) ? [value.value] : [],
        );
      }),
    ),
  );
  const update = Effect.fn("RecoveryRecordFiles.update")((record: A) =>
    lock.withPermit(
      Effect.gen(function* () {
        const file = fileFor(options.idOf(record));
        // Never silently overwrite malformed evidence, even on explicit admission.
        yield* read(file);
        const content = yield* options
          .encode(record)
          .pipe(Effect.mapError(failure("encode", file)));
        yield* atomicWriteFile(fs, path, file, content, (operation, cause) =>
          options.onError(operation, file, cause),
        );
        committed.set(file, Option.some(record));
      }).pipe(Effect.uninterruptible),
    ),
  );
  const remove = Effect.fn("RecoveryRecordFiles.remove")((id: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const file = fileFor(id);
        if (Option.isNone(yield* read(file))) return;
        yield* fs.remove(file).pipe(Effect.mapError(failure("remove", file)));
        committed.set(file, Option.none());
      }).pipe(Effect.uninterruptible),
    ),
  );
  return { get, list, update, remove };
});
