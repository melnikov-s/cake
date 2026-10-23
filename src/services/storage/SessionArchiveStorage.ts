import { Context, type Effect, Schema, type Stream } from "effect";
import type { PiSessionSummary } from "../../contracts/conversations/session-contract";

export const SessionResolutionIndex = Schema.Struct({
  version: Schema.Literal(1),
  directories: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});

export const SessionArchiveLocation = Schema.Struct({
  cwd: Schema.String,
  activeRoot: Schema.String,
  /** Former archive root, used only to migrate persisted transcripts back in place. */
  resolvedRoot: Schema.String,
  direct: Schema.optionalKey(Schema.Boolean),
});
export interface SessionArchiveLocation extends Schema.Schema.Type<typeof SessionArchiveLocation> {}

export const ProjectSessionArchiveMetadata = Schema.Struct({
  version: Schema.Literal(2),
  sessionId: Schema.String,
  projectPath: Schema.String,
  projectName: Schema.String,
  workingDirectory: Schema.String,
  activeRoot: Schema.String,
  resolvedRoot: Schema.String,
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  worktreeName: Schema.optionalKey(Schema.String),
});
export interface ProjectSessionArchiveMetadata extends Schema.Schema.Type<
  typeof ProjectSessionArchiveMetadata
> {}

export interface ProjectSessionArchiveContext {
  readonly projectPath: string;
  readonly projectName: string;
  readonly worktreeName?: string;
}

export interface ProjectSessionArchiveMigrationSource {
  readonly location: SessionArchiveLocation;
  readonly worktreeName?: string;
}

export class SessionArchiveStorageError extends Schema.TaggedError<SessionArchiveStorageError>()(
  "SessionArchiveStorageError",
  { operation: Schema.String, sessionId: Schema.String, message: Schema.String },
) {}

export class SessionArchiveStorage extends Context.Service<
  SessionArchiveStorage,
  {
    /** Explicit migration operation: rebind metadata after an exclusive transcript copy. */
    readonly relocate: (
      sessionId: string,
      from: SessionArchiveLocation,
      to: SessionArchiveLocation,
      resolved: boolean,
      metadata?: ProjectSessionArchiveMetadata,
    ) => Effect.Effect<void, SessionArchiveStorageError>;
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
    /** Exact Pi transcript deletion for owned auxiliary sessions, which have no resolution namespace.
     * Missing originals are idempotent; ownership metadata is removed by the caller afterward. */
    readonly deleteAuxiliary: (
      sessionId: string,
      location: Pick<SessionArchiveLocation, "cwd" | "activeRoot" | "direct">,
    ) => Effect.Effect<void, SessionArchiveStorageError>;
    readonly delete: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<void, SessionArchiveStorageError>;
    readonly locate: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<"active" | "resolved" | undefined, SessionArchiveStorageError>;
    /** Pure read of the existing authoritative index, once; no migration or transcript IO. */
    readonly resolutionSnapshot: () => Effect.Effect<
      typeof SessionResolutionIndex.Type,
      SessionArchiveStorageError
    >;
    /** Read the resolution index only; unlike resolvedIds, never migrates legacy files. */
    readonly recordedResolvedIds: (
      location: SessionArchiveLocation,
    ) => Effect.Effect<ReadonlySet<string>, SessionArchiveStorageError>;
    /** One metadata read per listing; never reads transcript bodies. */
    readonly resolvedIds: (
      location: SessionArchiveLocation,
    ) => Effect.Effect<ReadonlySet<string>, SessionArchiveStorageError>;
    readonly resolved: (
      location: SessionArchiveLocation,
    ) => Stream.Stream<PiSessionSummary, SessionArchiveStorageError>;
    readonly resolvedEntry: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<PiSessionSummary | undefined, SessionArchiveStorageError>;
    readonly resolveProject: (
      sessionId: string,
      location: SessionArchiveLocation,
      context: ProjectSessionArchiveContext,
    ) => Effect.Effect<boolean, SessionArchiveStorageError>;
    readonly restoreProject: (
      sessionId: string,
    ) => Effect.Effect<ProjectSessionArchiveMetadata | undefined, SessionArchiveStorageError>;
    readonly deleteResolvedProject: (
      sessionId: string,
    ) => Effect.Effect<void, SessionArchiveStorageError>;
    readonly resolvedProjects: (
      projectPath: string,
    ) => Stream.Stream<ProjectSessionArchiveMetadata, SessionArchiveStorageError>;
    readonly projectMigrationComplete: (
      projectPath: string,
    ) => Effect.Effect<boolean, SessionArchiveStorageError>;
    readonly migrateProject: (
      projectPath: string,
      projectName: string,
      sources: ReadonlyArray<ProjectSessionArchiveMigrationSource>,
    ) => Stream.Stream<ProjectSessionArchiveMetadata, SessionArchiveStorageError>;
    readonly resolvedProjectEntry: (
      sessionId: string,
    ) => Effect.Effect<ProjectSessionArchiveMetadata | undefined, SessionArchiveStorageError>;
  }
>()("cake/services/storage/SessionArchiveStorage") {}
