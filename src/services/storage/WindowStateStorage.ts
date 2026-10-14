import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { atomicWriteFile, type AtomicFileStage } from "./internal/atomicFile";
import {
  WindowStateReadError,
  WindowStateMalformedDocumentError,
  WindowStateUnsupportedVersionError,
  WindowStateEncodeError,
  WindowStateWriteError,
} from "../../contracts/storage/window-state-storage-errors";

export const WINDOW_STATE_DOCUMENT_VERSION = 14;
const WINDOW_STATE_DOCUMENT_NAME = "window-state.json";

const EmptyWindowSnapshot: Schema.Schema.Type<typeof Schema.Json> = {
  state: {},
  children: {},
};

const StoredEnvelope = Schema.Struct({
  version: Schema.Int,
  data: Schema.Json,
});

export class WindowStateStorage extends Context.Service<
  WindowStateStorage,
  {
    readonly load: () => Effect.Effect<
      Schema.Schema.Type<typeof Schema.Json>,
      WindowStateReadError | WindowStateMalformedDocumentError | WindowStateUnsupportedVersionError
    >;
    readonly save: (
      snapshot: Schema.Schema.Type<typeof Schema.Json>,
    ) => Effect.Effect<void, WindowStateEncodeError | WindowStateWriteError>;
  }
>()("cake/services/storage/WindowStateStorage") {}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const writeError = (stage: AtomicFileStage, cause: unknown) =>
  new WindowStateWriteError({ stage, message: messageOf(cause) });

export const makeWindowStateStorageLive = (userDataDirectory: string) =>
  Layer.effect(
    WindowStateStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const documentPath = path.join(userDataDirectory, WINDOW_STATE_DOCUMENT_NAME);
      const lock = yield* Semaphore.make(1);

      const saveUnlocked = Effect.fn("WindowStateStorage.save")(function* (
        snapshot: Schema.Schema.Type<typeof Schema.Json>,
      ) {
        const data = yield* Schema.encodeEffect(Schema.Json)(snapshot).pipe(
          Effect.mapError((cause) => new WindowStateEncodeError({ message: cause.message })),
        );
        const content = yield* Effect.try({
          try: () =>
            `${JSON.stringify({ version: WINDOW_STATE_DOCUMENT_VERSION, data }, null, 2)}\n`,
          catch: (cause) => new WindowStateEncodeError({ message: messageOf(cause) }),
        });
        yield* atomicWriteFile(fileSystem, path, documentPath, content, writeError);
      });

      const loadUnlocked = Effect.fn("WindowStateStorage.load")(function* () {
        const exists = yield* fileSystem
          .exists(documentPath)
          .pipe(Effect.mapError((cause) => new WindowStateReadError({ message: cause.message })));
        if (!exists) return EmptyWindowSnapshot;
        const text = yield* fileSystem
          .readFileString(documentPath)
          .pipe(Effect.mapError((cause) => new WindowStateReadError({ message: cause.message })));
        const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          text,
        ).pipe(
          Effect.mapError(
            (cause) => new WindowStateMalformedDocumentError({ message: cause.message }),
          ),
        );
        const envelope = yield* Schema.decodeUnknownEffect(StoredEnvelope)(parsed).pipe(
          Effect.mapError(
            (cause) => new WindowStateMalformedDocumentError({ message: cause.message }),
          ),
        );
        if (envelope.version !== WINDOW_STATE_DOCUMENT_VERSION)
          return yield* new WindowStateUnsupportedVersionError({
            version: envelope.version,
            currentVersion: WINDOW_STATE_DOCUMENT_VERSION,
          });
        return envelope.data;
      });

      return WindowStateStorage.of({
        load: Effect.fn("WindowStateStorage.loadSerialized")(() =>
          lock.withPermits(1)(loadUnlocked()),
        ),
        save: Effect.fn("WindowStateStorage.saveSerialized")((snapshot) =>
          lock.withPermits(1)(saveUnlocked(snapshot)),
        ),
      });
    }),
  );
