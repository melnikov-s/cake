import { Context, Schema, type Effect } from "effect";
import type { cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type { ProjectSessionRuntimeIntegrations } from "./ProjectSessionIntegrationHost";

export class ProjectSessionRuntimeHostError extends Schema.TaggedError<ProjectSessionRuntimeHostError>()(
  "ProjectSessionRuntimeHostError",
  { operation: Schema.String, message: Schema.String },
) {}

type ArtifactResponse = (typeof cakeRpcPayloadSchemas)["respond-artifact"]["Type"];
type UiResponse = (typeof cakeRpcPayloadSchemas)["respond-ui"]["Type"];

/**
 * Scoped Cake UI/artifact integrations attached to authoritative Pi Session runtimes.
 */
export class ProjectSessionRuntimeHost extends Context.Service<
  ProjectSessionRuntimeHost,
  {
    readonly stopWorkingDirectory: (
      workingDirectory: string,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly cancelPendingRequests: (
      workingDirectory: string,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly runtimeIntegrations: (
      workingDirectory: string,
      sessionId: string,
    ) => Effect.Effect<ProjectSessionRuntimeIntegrations, ProjectSessionRuntimeHostError>;
    readonly releaseSession: (
      sessionId: string,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly bindRenderer: (
      sessionId: string,
      connectionId: number,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly respondArtifact: (
      sessionId: string,
      response: ArtifactResponse,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly respondUi: (
      sessionId: string,
      response: UiResponse,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
    readonly respondControl: (
      sessionId: string,
      controlRequestId: string,
      result: JsonValue,
    ) => Effect.Effect<void, ProjectSessionRuntimeHostError>;
  }
>()("cake/services/pi/ProjectSessionRuntimeHost") {}
