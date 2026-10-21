import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SessionCoordinationStorageError } from "../../contracts/storage/session-coordination-storage-errors";
import { atomicWriteFile } from "./internal/atomicFile";

const Message = Schema.Struct({
  messageId: Schema.String,
  senderSessionId: Schema.String,
  targetSessionId: Schema.String,
  turnId: Schema.String,
  delivery: Schema.Literals(["fyi", "prompt", "queue", "steer"]),
  status: Schema.Literals([
    "accepted",
    "deferred",
    "queued",
    "delivered",
    "processing",
    "answered",
    "failed",
    "canceled",
  ]),
});
const Thread = Schema.Struct({
  threadId: Schema.String,
  participants: Schema.Tuple([Schema.String, Schema.String]),
  maxMessages: Schema.optionalKey(Schema.Int),
  messages: Schema.Array(Message),
  state: Schema.Literals(["open", "closed"]),
});

/** Correlation metadata only. Message bodies and transcript history remain Pi-owned. */
export const SessionCoordinationDocument = Schema.Struct({
  threads: Schema.Array(Thread),
  latest: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  outcomes: Schema.Array(
    Schema.Tuple([Schema.String, Schema.Literals(["complete", "failed", "aborted"])]),
  ),
});
export interface SessionCoordinationDocument extends Schema.Schema.Type<
  typeof SessionCoordinationDocument
> {}
const Envelope = Schema.Struct({ version: Schema.Int, data: Schema.Unknown });

export class SessionCoordinationStorage extends Context.Service<
  SessionCoordinationStorage,
  {
    readonly load: () => Effect.Effect<
      SessionCoordinationDocument,
      SessionCoordinationStorageError
    >;
    readonly save: (
      document: SessionCoordinationDocument,
    ) => Effect.Effect<void, SessionCoordinationStorageError>;
  }
>()("cake/services/storage/SessionCoordinationStorage") {}

/** One backend coordinator owns mutations; each replacement commits its complete metadata snapshot. */
export const makeSessionCoordinationStorageLive = (documentPath: string) =>
  Layer.effect(
    SessionCoordinationStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const failure = (operation: string, cause: unknown) =>
        new SessionCoordinationStorageError({
          operation,
          message: `Cannot ${operation} session coordination metadata at ${documentPath}: ${String(cause)}. Restore this file and restart to recover coordination; Pi transcripts have not been replaced.`,
        });
      return SessionCoordinationStorage.of({
        load: Effect.fn("SessionCoordinationStorage.load")(function* () {
          if (!(yield* fs.exists(documentPath).pipe(Effect.mapError((e) => failure("load", e)))))
            return { threads: [], latest: [], outcomes: [] };
          const text = yield* fs
            .readFileString(documentPath)
            .pipe(Effect.mapError((e) => failure("load", e)));
          const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(
            text,
          ).pipe(Effect.mapError((e) => failure("load", e)));
          if (envelope.version !== 1 && envelope.version !== 2)
            return yield* failure(
              "load",
              `Unsupported session coordination document version ${envelope.version}`,
            );
          return yield* Schema.decodeUnknownEffect(SessionCoordinationDocument)(envelope.data).pipe(
            Effect.mapError((e) => failure("load", e)),
          );
        }),
        save: Effect.fn("SessionCoordinationStorage.save")(function* (document) {
          const encoded = yield* Schema.encodeEffect(SessionCoordinationDocument)(document).pipe(
            Effect.mapError((e) => failure("save", e)),
          );
          yield* atomicWriteFile(
            fs,
            path,
            documentPath,
            JSON.stringify({ version: 2, data: encoded }),
            failure,
          );
        }),
      });
    }),
  );
