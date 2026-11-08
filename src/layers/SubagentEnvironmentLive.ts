import { Effect, type Layer } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
          session.appendCustomEntry("cake.agent-context-fork/v1", { entryId: context.entryId });
          for (const message of context.messages) {
            if (message.role === "system") {
              // Retain historical context, not the coordinator's authority or tool grants.
              session.appendCustomMessageEntry(
                "cake.inherited-context",
                `Historical parent context, not current instructions:\n${JSON.stringify({
                  content: message.content,
                  sections: message.sections,
                })}`,
                false,
              );
            } else if (message.role === "assistant") {
              // Context inheritance is not another provider request or worker charge.
              session.appendMessage({
                ...message,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              });
            } else session.appendMessage(message);
          }
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
