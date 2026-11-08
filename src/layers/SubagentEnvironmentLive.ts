import { Effect, type Layer } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendAgentContextFork } from "../services/pi/runtime/agent-context-fork";
import { workingDirectorySessionPath } from "../services/storage/session-files";
import { SubagentEnvironmentError } from "../services/subagents/SubagentEnvironment";
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
    seedContext: (workingDirectory, sessionId, context) =>
      Effect.try({
        try: () => {
          const session = SessionManager.create(
            workingDirectory,
            workingDirectorySessionPath(workingDirectory, options.sessionDirectory),
            { id: sessionId },
          );
          appendAgentContextFork(session, context);
        },
        catch: (error) =>
          new SubagentEnvironmentError({
            operation: "seedContext",
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    location: Effect.fn("SubagentEnvironment.location")((workingDirectory) =>
      Effect.succeed({
        workingDirectory: workingDirectory ?? options.homeDirectory,
        agentDirectory: options.agentDirectory,
        sessionDirectory: options.sessionDirectory,
      }),
    ),
  });
