import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  RendererApplicationProjection,
  RendererApplicationState,
} from "../../domain/application-data";
import { AgentAvailabilitySnapshot } from "../../domain/agent-availability-data";

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
);
