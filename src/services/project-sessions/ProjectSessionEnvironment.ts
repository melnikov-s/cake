import { Context, Layer, Schema } from "effect";
import type { Effect } from "effect";
import type { PiSessionAcquireOptions } from "../pi/PiSessions";
import { ManagedWorktreeContext } from "../../domain/managed-worktree-data";

export const ProjectSessionLocation = Schema.Struct({
  projectPath: Schema.String,
  projectName: Schema.String,
  workingDirectory: Schema.String,
  sessionDirectory: Schema.String,
  resolvedSessionDirectory: Schema.String,
  managedWorktree: Schema.optionalKey(ManagedWorktreeContext),
  worktreeName: Schema.optionalKey(Schema.String),
});
export interface ProjectSessionLocation extends Schema.Schema.Type<typeof ProjectSessionLocation> {}

export class ProjectSessionEnvironmentError extends Schema.TaggedError<ProjectSessionEnvironmentError>()(
  "ProjectSessionEnvironmentError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ProjectSessionEnvironmentService {
  readonly locations: (options?: {
    readonly includeInactive?: boolean;
  }) => Effect.Effect<ReadonlyArray<ProjectSessionLocation>, ProjectSessionEnvironmentError>;
  readonly runtimeOptions: (input: {
    readonly location: ProjectSessionLocation;
    readonly sessionId: string;
    readonly newSession: boolean;
  }) => Effect.Effect<PiSessionAcquireOptions, ProjectSessionEnvironmentError>;
  readonly archive: (
    sessionId: string,
    location: ProjectSessionLocation,
  ) => Effect.Effect<void, ProjectSessionEnvironmentError>;
  readonly restore: (
    sessionId: string,
    location: ProjectSessionLocation,
  ) => Effect.Effect<ProjectSessionLocation, ProjectSessionEnvironmentError>;
  readonly forkToWorkingDirectory: (input: {
    readonly sessionId: string;
    readonly entryId: string;
    readonly title: string;
    readonly source: ProjectSessionLocation;
    readonly destination: ProjectSessionLocation;
  }) => Effect.Effect<string, ProjectSessionEnvironmentError>;
}

/** Outside-world adapter for Project Session paths and archive operations. */
export class ProjectSessionEnvironment extends Context.Service<
  ProjectSessionEnvironment,
  ProjectSessionEnvironmentService
>()("cake/services/project-sessions/ProjectSessionEnvironment") {}

export const makeProjectSessionEnvironmentLayer = (
  service: ProjectSessionEnvironmentService,
): Layer.Layer<ProjectSessionEnvironment> =>
  Layer.succeed(ProjectSessionEnvironment, ProjectSessionEnvironment.of(service));
