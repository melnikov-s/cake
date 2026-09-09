import { Context, Schema, type Effect } from "effect";
import type { ProjectSessionRuntimeIntegrations } from "./ProjectSessionIntegrationHost";

export class ProjectSessionRuntimeHostError extends Schema.TaggedError<ProjectSessionRuntimeHostError>()(
  "ProjectSessionRuntimeHostError",
  { operation: Schema.String, message: Schema.String },
) {}

/**
 * Scoped Cake UI/artifact integrations attached to authoritative Pi Session runtimes.
 */
export class ProjectSessionRuntimeHost extends Context.Service<
  ProjectSessionRuntimeHost,
  {
    readonly stopWorkingDirectory: (
      workingDirectory: string,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly runtimeIntegrations: (
      workingDirectory: string,
      sessionId: string,
    ) => Effect.Effect<ProjectSessionRuntimeIntegrations, ProjectSessionRuntimeHostError>;
    readonly releaseSession: (
      sessionId: string,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
  }
>()("cake/services/pi/ProjectSessionRuntimeHost") {}
