import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import {
  ScheduledMessage,
  type ScheduledMessage as ScheduledMessageValue,
} from "../../domain/scheduled-messages/scheduled-message-data";
import { atomicWriteFile } from "./internal/atomicFile";

const DOCUMENT_VERSION = 1;
const SCHEDULED_MESSAGES_DOCUMENT_NAME = "scheduled-messages.json";

export class ScheduledMessageStorageError extends Schema.TaggedError<ScheduledMessageStorageError>()(
  "ScheduledMessageStorageError",
  { operation: Schema.String, message: Schema.String },
) {}

export class ScheduledMessageStorage extends Context.Service<
  ScheduledMessageStorage,
  {
    readonly load: () => Effect.Effect<
      ReadonlyArray<ScheduledMessageValue>,
      ScheduledMessageStorageError
    >;
    readonly save: (
      messages: ReadonlyArray<ScheduledMessageValue>,
    ) => Effect.Effect<void, ScheduledMessageStorageError>;
  }
>()("cake/services/storage/ScheduledMessageStorage") {}

const StoredDocument = Schema.Struct({
  version: Schema.Literal(DOCUMENT_VERSION),
  data: Schema.Array(ScheduledMessage).check(Schema.isMaxLength(10_000)),
});

const storageError = (operation: string, cause: unknown) =>
  new ScheduledMessageStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeScheduledMessageStorageLive = (stateDirectory: string) =>
  Layer.effect(
    ScheduledMessageStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const documentPath = path.join(stateDirectory, SCHEDULED_MESSAGES_DOCUMENT_NAME);
      const lock = yield* Semaphore.make(1);

      const load = Effect.fn("ScheduledMessageStorage.load")(function* () {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const exists = yield* fileSystem
              .exists(documentPath)
              .pipe(Effect.mapError((cause) => storageError("load", cause)));
            if (!exists) return [];
            const text = yield* fileSystem
              .readFileString(documentPath)
              .pipe(Effect.mapError((cause) => storageError("load", cause)));
            const parsed: unknown = yield* Effect.try({
              try: () => JSON.parse(text),
              catch: (cause) => storageError("decode", cause),
            });
            const document = yield* Schema.decodeUnknownEffect(StoredDocument)(parsed).pipe(
              Effect.mapError((cause) => storageError("decode", cause)),
            );
            return document.data;
          }),
        );
      });

      const save = Effect.fn("ScheduledMessageStorage.save")(function* (
        messages: ReadonlyArray<ScheduledMessageValue>,
      ) {
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const document = yield* Schema.encodeEffect(StoredDocument)({
              version: DOCUMENT_VERSION,
              data: messages,
            }).pipe(Effect.mapError((cause) => storageError("encode", cause)));
            const content = `${JSON.stringify(document, null, 2)}\n`;
            yield* atomicWriteFile(fileSystem, path, documentPath, content, (stage, cause) =>
              storageError(stage, cause),
            );
          }),
        );
      });

      return ScheduledMessageStorage.of({ load, save });
    }),
  );
