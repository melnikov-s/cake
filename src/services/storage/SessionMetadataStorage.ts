import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import { KeyedSerialExecutor } from "../../utils/KeyedSerialExecutor";
import { AtomicFileWriter } from "./internal/AtomicFileWriter";

const SessionMetadataDocument = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH)),
});

interface SessionMetadataDocument extends Schema.Schema.Type<typeof SessionMetadataDocument> {}

export class SessionMetadataStorageError extends Schema.TaggedError<SessionMetadataStorageError>()(
  "SessionMetadataStorageError",
  { operation: Schema.String, sessionId: Schema.String, message: Schema.String },
) {}

export class SessionMetadataStorage extends Context.Service<
  SessionMetadataStorage,
  {
    readonly title: (
      sessionId: string,
    ) => Effect.Effect<string | undefined, SessionMetadataStorageError>;
    readonly setTitle: (
      sessionId: string,
      title: string,
    ) => Effect.Effect<boolean, SessionMetadataStorageError>;
    readonly remove: (sessionId: string) => Effect.Effect<void, SessionMetadataStorageError>;
  }
>()("cake/services/storage/SessionMetadataStorage") {}

const storageError = (operation: string, sessionId: string, cause: unknown) =>
  new SessionMetadataStorageError({
    operation,
    sessionId,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const digest = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");

export const makeSessionMetadataStorageLive = (root: string): Layer.Layer<SessionMetadataStorage> =>
  Layer.sync(SessionMetadataStorage, () => {
    const writer = new AtomicFileWriter();
    const updates = new KeyedSerialExecutor<string>();
    const documentPath = (sessionId: string) => {
      const key = digest(sessionId);
      return join(root, key.slice(0, 2), `${key}.json`);
    };
    const read = async (sessionId: string): Promise<SessionMetadataDocument | undefined> => {
      try {
        const document = Schema.decodeUnknownSync(SessionMetadataDocument)(
          JSON.parse(await readFile(documentPath(sessionId), "utf8")),
        );
        if (document.sessionId !== sessionId) throw new Error("Session metadata identity mismatch");
        return document;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    };

    return SessionMetadataStorage.of({
      title: Effect.fn("SessionMetadataStorage.title")((sessionId) =>
        Effect.tryPromise({
          try: async () => (await read(sessionId))?.title,
          catch: (cause) => storageError("title", sessionId, cause),
        }),
      ),
      setTitle: Effect.fn("SessionMetadataStorage.setTitle")((sessionId, title) => {
        const normalized = title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
        if (!normalized) return Effect.succeed(false);
        const target = documentPath(sessionId);
        return Effect.tryPromise({
          try: () =>
            updates.run(target, async () => {
              const current = await read(sessionId);
              if (current?.title === normalized) return false;
              const next = Schema.decodeUnknownSync(SessionMetadataDocument)({
                version: 1,
                sessionId,
                title: normalized,
              });
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              await writer.write(target, `${JSON.stringify(next, null, 2)}\n`);
              return true;
            }),
          catch: (cause) => storageError("setTitle", sessionId, cause),
        });
      }),
      remove: Effect.fn("SessionMetadataStorage.remove")((sessionId) => {
        const target = documentPath(sessionId);
        return Effect.tryPromise({
          try: () => updates.run(target, () => rm(target, { force: true })),
          catch: (cause) => storageError("remove", sessionId, cause),
        });
      }),
    });
  });
