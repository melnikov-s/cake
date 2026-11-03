import { Effect, type Layer } from "effect";
import type { SubagentEnvironment } from "../services/subagents/SubagentEnvironment";
import { makeSubagentEnvironmentLayer } from "../services/subagents/SubagentEnvironment";

export interface SubagentEnvironmentLiveOptions {
  readonly homeDirectory: string;
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
}

export const makeSubagentEnvironmentLive = (
  options: SubagentEnvironmentLiveOptions,
): Layer.Layer<SubagentEnvironment> =>
  makeSubagentEnvironmentLayer({
    location: Effect.fn("SubagentEnvironment.location")((workingDirectory) =>
      Effect.succeed({
        workingDirectory: workingDirectory ?? options.homeDirectory,
        agentDirectory: options.agentDirectory,
        sessionDirectory: options.sessionDirectory,
      }),
    ),
  });
