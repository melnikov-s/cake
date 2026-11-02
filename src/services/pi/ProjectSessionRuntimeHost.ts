import { Context, Schema, type Effect } from "effect";
import type { CakeSessionRuntimeOptions } from "./runtime/cake-session-runtime";
import type { CakeOperationOptions } from "../../contracts/agent/cake-operation-options";
import type { ProjectSessionControlInvocation } from "../../contracts/project-sessions/project-session-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";

export type ProjectSessionRuntimeIntegrations = Pick<
  CakeOperationOptions,
  | "messageBoardControl"
  | "generateInlineWidget"
  | "captureWidgetInstance"
  | "reviseInlineWidget"
  | "readArtifactState"
  | "replaceArtifactState"
  | "updateArtifactState"
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
  Pick<
    CakeSessionRuntimeOptions,
    "requestUi" | "emitExtensionUiIntent" | "reviewContextPath" | "compileArtifactBrowser"
  > & {
    readonly requestApplicationControl: (
      invocation: ProjectSessionControlInvocation,
      signal: AbortSignal,
    ) => Promise<JsonValue>;
  };

export class ProjectSessionRuntimeHostError extends Schema.TaggedError<ProjectSessionRuntimeHostError>()(
  "ProjectSessionRuntimeHostError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface PreparedProjectSessionRuntime {
  readonly integrations: ProjectSessionRuntimeIntegrations;
  readonly initialize: Effect.Effect<void, ProjectSessionRuntimeHostError>;
  readonly release: Effect.Effect<void, ProjectSessionRuntimeHostError>;
}

/**
 * Prepares instance-owned integrations; only actual Pi runtime construction activates them.
 */
export class ProjectSessionRuntimeHost extends Context.Service<
  ProjectSessionRuntimeHost,
  {
    readonly stopWorkingDirectory: (
      workingDirectory: string,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly prepare: (
      workingDirectory: string,
      sessionId: string,
    ) => Effect.Effect<PreparedProjectSessionRuntime, ProjectSessionRuntimeHostError>;
  }
>()("cake/services/pi/ProjectSessionRuntimeHost") {}
