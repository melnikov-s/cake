import { Effect, Layer } from "effect";
import type { PiPluginAgents } from "./PiPluginAgents";
import { makePiPluginAgentsLive } from "./PiPluginAgentsLive";
import type { PiSessions } from "./PiSessions";
import { ProjectSessionIntegrations } from "./ProjectSessionIntegrations";
import { ProjectSessionRuntimeOptions } from "./ProjectSessionRuntimeOptions";

export interface PiPluginAgentsProductionLiveOptions {
  readonly projectSessionDirectory: string;
  readonly privateSessionDirectory: string;
}

export const makePiPluginAgentsProductionLive = (
  options: PiPluginAgentsProductionLiveOptions,
): Layer.Layer<
  PiPluginAgents,
  never,
  PiSessions | ProjectSessionIntegrations | ProjectSessionRuntimeOptions
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const integrations = yield* ProjectSessionIntegrations;
      const projectRuntime = yield* ProjectSessionRuntimeOptions;
      const context = yield* Effect.context<PiSessions>();
      const run = Effect.runPromiseWith(context);
      return makePiPluginAgentsLive({
        projectSessionDirectory: options.projectSessionDirectory,
        privateSessionDirectory: options.privateSessionDirectory,
        runEffect: (effect, signal) => run(effect, { signal }),
        runtimeOptions: (workingDirectory, input) => {
          const base = projectRuntime.forWorkingDirectory(workingDirectory);
          return {
            runtime: {
              ...Effect.runSync(
                integrations.projectSessionRuntimeIntegrations(workingDirectory, input.sessionId),
              ),
              cwd: workingDirectory,
              trusted: base.isTrusted?.() ?? false,
              agentDir: base.agentDir,
              sessionDir: input.sessionDirectory,
              resolvedSessionDir:
                input.visibility === "project" ? base.resolvedSessionDir : undefined,
              newSession: input.newSession,
              sessionId: input.sessionId,
              sessionFile: input.sessionFile,
              pluginResources: base.pluginResources,
              additionalSystemPrompt: input.instructions,
              utilityModel: base.utilityModel,
              generateSessionTitle: base.generateSessionTitle,
              modelPresets: base.modelPresets,
              fastMode: {
                get: () => base.fastMode?.(input.sessionId) ?? false,
                set: (enabled) => base.setFastMode?.(input.sessionId, enabled) ?? Promise.resolve(),
              },
              currentSessionControl: {
                resolved: () => base.sessionResolved?.(input.sessionId) ?? false,
                setResolved: (resolved) =>
                  base.setSessionResolved?.(input.sessionId, resolved) ?? Promise.resolve(),
              },
              worktreeLandingControl:
                input.visibility === "project"
                  ? {
                      proposeSquashMessage: (message) =>
                        base.worktreeLanding?.proposeSquashMessage({
                          workspacePath: workingDirectory,
                          ...message,
                        }) ?? Promise.resolve(),
                    }
                  : undefined,
              vscodeControl:
                input.visibility === "project" && base.openInEditor
                  ? { open: base.openInEditor }
                  : undefined,
              openExternal: base.openExternal,
            },
            onRelease: () => run(integrations.releaseSession(input.sessionId)),
          };
        },
      }).layer;
    }),
  );
