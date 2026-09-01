import { Context, type Effect, Schema } from "effect";
import type { PluginAgentDriver } from "../plugins/plugin-agent-host";

export class PiPluginAgentsError extends Schema.TaggedError<PiPluginAgentsError>()(
  "PiPluginAgentsError",
  { operation: Schema.String, message: Schema.String },
) {}

export class PiPluginAgents extends Context.Service<
  PiPluginAgents,
  {
    readonly driver: (workingDirectory: string) => PluginAgentDriver;
    readonly closeAll: () => Effect.Effect<void, PiPluginAgentsError>;
  }
>()("cake/services/pi/PiPluginAgents") {}
