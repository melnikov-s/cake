import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  RendererApplicationProjection,
  RendererApplicationState,
} from "../../domain/application/application-data";
import { AgentAvailabilitySnapshot } from "../../domain/application/agent-availability-data";

export class SessionPluginMutationError extends Schema.TaggedError<SessionPluginMutationError>()(
  "SessionPluginMutationError",
  { message: Schema.String },
) {}

export const ApplicationRpc = RpcGroup.make(
  Rpc.make("application.getState", { success: RendererApplicationState }),
  Rpc.make("application.observeState", {
    success: RendererApplicationProjection,
    stream: true,
  }),
  Rpc.make("application.observeAgentAvailability", {
    success: AgentAvailabilitySnapshot,
    stream: true,
  }),
  Rpc.make("application.setSessionPluginHidden", {
    payload: { sessionId: Schema.String, pluginId: Schema.String, hidden: Schema.Boolean },
    success: Schema.Void,
    error: SessionPluginMutationError,
  }),
  Rpc.make("application.setSessionPluginState", {
    payload: {
      sessionId: Schema.String,
      pluginId: Schema.String,
      state: Schema.Json,
    },
    success: Schema.Void,
    error: SessionPluginMutationError,
  }),
  Rpc.make("application.setSessionPluginSharedState", {
    payload: {
      sessionId: Schema.String,
      key: Schema.String,
      value: Schema.Json,
    },
    success: Schema.Void,
    error: SessionPluginMutationError,
  }),
  Rpc.make("application.deleteSessionPlugin", {
    payload: { sessionId: Schema.String, pluginId: Schema.String },
    success: Schema.Void,
    error: SessionPluginMutationError,
  }),
);
