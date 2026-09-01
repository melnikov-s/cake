import { Effect, Layer } from "effect";
import { ApplicationState } from "../services/storage/ApplicationState";
import type { SubagentEnvironment } from "../services/subagents/SubagentEnvironment";
import { makeSubagentEnvironmentLayer } from "../services/subagents/SubagentEnvironment";

export interface SubagentEnvironmentLiveOptions {
  readonly homeDirectory: string;
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
}

export const makeSubagentEnvironmentLive = (
  options: SubagentEnvironmentLiveOptions,
): Layer.Layer<SubagentEnvironment, never, ApplicationState> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const application = yield* ApplicationState;
      return makeSubagentEnvironmentLayer({
        location: Effect.fn("SubagentEnvironment.location")((workingDirectory) =>
          Effect.succeed({
            workingDirectory,
            agentDirectory: options.agentDirectory,
            sessionDirectory: options.sessionDirectory,
            trusted:
              application.snapshot().trustedProjectPaths.includes(workingDirectory) ||
              workingDirectory === options.homeDirectory,
          }),
        ),
      });
    }),
  );
