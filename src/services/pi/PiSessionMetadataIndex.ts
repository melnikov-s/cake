import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import { KeyedSerialExecutor } from "../../utils/KeyedSerialExecutor";
import { AtomicFileWriter } from "../storage/internal/AtomicFileWriter";
import { sessionDirectoryPath } from "../storage/session-files";

const INDEX_FILENAME = ".pi-session-metadata.json";

const SessionMetadataEntry = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH)),
});

const SessionMetadataDocument = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Record(Schema.String, SessionMetadataEntry),
});

interface SessionMetadataDocument extends Schema.Schema.Type<typeof SessionMetadataDocument> {}

export interface PiSessionMetadataLocation {
  readonly workingDirectory: string;
  readonly sessionDirectory: string;
  readonly direct?: boolean;
}

export class PiSessionMetadataIndexError extends Schema.TaggedError<PiSessionMetadataIndexError>()(
  "PiSessionMetadataIndexError",
  { operation: Schema.String, message: Schema.String },
) {}

export class PiSessionMetadataIndex extends Context.Service<
  PiSessionMetadataIndex,
  {
    readonly titles: (
      location: PiSessionMetadataLocation,
    ) => Effect.Effect<ReadonlyMap<string, string>, PiSessionMetadataIndexError>;
    readonly setTitle: (
      location: PiSessionMetadataLocation,
      sessionId: string,
      title: string,
    ) => Effect.Effect<boolean, PiSessionMetadataIndexError>;
  }
>()("cake/services/pi/PiSessionMetadataIndex") {}

const errorValue = (operation: string, cause: unknown) =>
  new PiSessionMetadataIndexError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const emptyDocument = (): SessionMetadataDocument => ({ version: 1, sessions: {} });

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const PiSessionMetadataIndexLive = Layer.sync(PiSessionMetadataIndex, () => {
  const writer = new AtomicFileWriter();
  const updates = new KeyedSerialExecutor<string>();
  const indexPath = (location: PiSessionMetadataLocation) =>
    join(
      sessionDirectoryPath({
        workingDirectory: location.workingDirectory,
        root: location.sessionDirectory,
        direct: location.direct,
      }),
      INDEX_FILENAME,
    );
  const read = async (target: string): Promise<SessionMetadataDocument> => {
    try {
      return Schema.decodeUnknownSync(SessionMetadataDocument)(
        JSON.parse(await readFile(target, "utf8")),
      );
    } catch (error) {
      if (isMissing(error)) return emptyDocument();
      throw error;
    }
  };

  return PiSessionMetadataIndex.of({
    titles: Effect.fn("PiSessionMetadataIndex.titles")((location) => {
      const target = indexPath(location);
      return Effect.tryPromise({
        try: async () => {
          const document = await read(target);
          return new Map(
            Object.entries(document.sessions).map(([sessionId, entry]) => [sessionId, entry.title]),
          );
        },
        catch: (cause) => errorValue("titles", cause),
      });
    }),
    setTitle: Effect.fn("PiSessionMetadataIndex.setTitle")((location, sessionId, title) => {
      const target = indexPath(location);
      const normalized = title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
      if (!normalized) return Effect.succeed(false);
      return Effect.tryPromise({
        try: () =>
          updates.run(target, async () => {
            const current = await read(target);
            if (current.sessions[sessionId]?.title === normalized) return false;
            const next = Schema.decodeUnknownSync(SessionMetadataDocument)({
              version: 1,
              sessions: { ...current.sessions, [sessionId]: { title: normalized } },
            });
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writer.write(target, `${JSON.stringify(next, null, 2)}\n`);
            return true;
          }),
        catch: (cause) => errorValue("setTitle", cause),
      });
    }),
  });
});
