import { Context, type Effect, Schema, type Stream } from "effect";
import type { SessionSummary } from "../../ipc/session-contract";

export const SessionArchiveLocation = Schema.Struct({
  cwd: Schema.String,
  activeRoot: Schema.String,
  resolvedRoot: Schema.String,
  direct: Schema.optionalKey(Schema.Boolean),
});
export interface SessionArchiveLocation extends Schema.Schema.Type<typeof SessionArchiveLocation> {}

export const ProjectSessionArchiveMetadata = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  title: Schema.String,
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
    readonly resolvedEntry: (
      sessionId: string,
      location: SessionArchiveLocation,
    ) => Effect.Effect<SessionSummary | undefined, SessionArchiveStorageError>;
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
