import { Context, Schema, type Effect } from "effect";
import type { cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import type { ProjectSessionRuntimeIntegrations } from "./ProjectSessionIntegrationHost";

export class ProjectSessionIntegrationsError extends Schema.TaggedError<ProjectSessionIntegrationsError>()(
  "ProjectSessionIntegrationsError",
  { operation: Schema.String, message: Schema.String },
) {}

type ArtifactResponse = (typeof cakeRpcPayloadSchemas)["respond-artifact"]["Type"];
type UiResponse = (typeof cakeRpcPayloadSchemas)["respond-ui"]["Type"];

/**
 * Scoped Cake UI/artifact integrations attached to authoritative Pi Session runtimes.
 */
export class ProjectSessionIntegrations extends Context.Service<
  ProjectSessionIntegrations,
  {
    readonly stopWorkingDirectory: (
      workingDirectory: string,
    ) => Effect.Effect<void, ProjectSessionIntegrationsError>;
    readonly cancelPendingRequests: (
      workingDirectory: string,
    ) => Effect.Effect<void, ProjectSessionIntegrationsError>;
    readonly projectSessionRuntimeIntegrations: (
      workingDirectory: string,
      sessionId: string,
    ) => Effect.Effect<ProjectSessionRuntimeIntegrations, ProjectSessionIntegrationsError>;
    readonly releaseSession: (
      sessionId: string,
    ) => Effect.Effect<void, ProjectSessionIntegrationsError>;
    readonly respondArtifact: (
      sessionId: string,
      response: ArtifactResponse,
    ) => Effect.Effect<void, ProjectSessionIntegrationsError>;
    readonly respondUi: (
      sessionId: string,
      response: UiResponse,
    ) => Effect.Effect<void, ProjectSessionIntegrationsError>;
  }
>()("cake/services/pi/ProjectSessionIntegrations") {}
