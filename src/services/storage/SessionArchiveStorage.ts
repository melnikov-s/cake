import { Context, type Effect, Schema, type Stream } from "effect";
import type { SessionSummary } from "../../ipc/session-contract";

export const SessionArchiveLocation = Schema.Struct({
  cwd: Schema.String,
  activeRoot: Schema.String,
  resolvedRoot: Schema.String,
  direct: Schema.optionalKey(Schema.Boolean),
});
export interface SessionArchiveLocation extends Schema.Schema.Type<typeof SessionArchiveLocation> {}

export class SessionArchiveStorageError extends Schema.TaggedError<SessionArchiveStorageError>()(
  "SessionArchiveStorageError",
  { operation: Schema.String, sessionId: Schema.String, message: Schema.String },
) {}

export class SessionArchiveStorage extends Context.Service<
  SessionArchiveStorage,
  {
    readonly resolve: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<boolean, SessionArchiveStorageError>;
    readonly restore: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<boolean, SessionArchiveStorageError>;
    readonly deleteResolved: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<void, SessionArchiveStorageError>;
    readonly delete: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<void, SessionArchiveStorageError>;
    readonly locate: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<"active" | "resolved" | undefined, SessionArchiveStorageError>;
    readonly resolved: (
      location: SessionArchiveLocation,
    ) => Stream.Stream<SessionSummary, SessionArchiveStorageError>;
  }
>()("cake/services/storage/SessionArchiveStorage") {}
