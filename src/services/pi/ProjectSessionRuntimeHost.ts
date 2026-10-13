import { Context, Schema, type Effect } from "effect";
import type { CakeSessionRuntimeOptions } from "./runtime/cake-session-runtime";
import type { CakeOperationOptions } from "../../contracts/agent/cake-operation-options";
import type { ProjectSessionControlInvocation } from "../../contracts/project-sessions/project-session-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";

export type ProjectSessionRuntimeIntegrations = Pick<
  CakeOperationOptions,
  | "messageBoardControl"
  | "generateInlineWidget"
  | "reviseInlineWidget"
  | "resolveArtifact"
  | "hasLinkedArtifacts"
  | "listArtifactMetadata"
  | "historyArtifact"
  | "restoreArtifact"
  | "linkArtifact"
  | "unlinkArtifact"
  | "importArtifactFile"
  | "persistArtifact"
  | "requestInterview"
> &
  Pick<CakeSessionRuntimeOptions, "requestUi" | "emitExtensionUiIntent" | "reviewContextPath"> & {
    readonly requestApplicationControl: (
      invocation: ProjectSessionControlInvocation,
      signal: AbortSignal,
    ) => Promise<JsonValue>;
  };

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
