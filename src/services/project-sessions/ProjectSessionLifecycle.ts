import { Context, Schema, type Effect } from "effect";
import type { WorktreeRecord } from "../../ipc/worktree-contract";

export class ProjectSessionLifecycleError extends Schema.TaggedError<ProjectSessionLifecycleError>()(
  "ProjectSessionLifecycleError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ProjectSessionLifecycleService {
  readonly setCakeChatResolved: (
    sessionId: string,
    resolved: boolean,
  ) => Effect.Effect<void, ProjectSessionLifecycleError>;
  readonly setProjectSessionResolved: (
    sessionId: string,
    resolved: boolean,
    knownWorkingDirectory?: string,
  ) => Effect.Effect<void, ProjectSessionLifecycleError>;
  readonly deleteResolvedProjectSession: (
    sessionId: string,
  ) => Effect.Effect<void, ProjectSessionLifecycleError>;
  readonly deleteProjectSessions: (
    projectPath: string,
    records: ReadonlyArray<WorktreeRecord>,
  ) => Effect.Effect<void, ProjectSessionLifecycleError>;
}

/** Coordinates transcript archive storage with Project Session native resources. */
export class ProjectSessionLifecycle extends Context.Service<
  ProjectSessionLifecycle,
  ProjectSessionLifecycleService
>()("cake/services/project-sessions/ProjectSessionLifecycle") {}
