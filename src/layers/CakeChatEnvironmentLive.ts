import { Effect, Layer, Schema } from "effect";
import { setSessionFastMode } from "../domain/application";
import { makeSubagentControl } from "../domain/subagentControl";
import { jsonObjectSchema } from "../ipc/json-contract";
import type { PiSessions } from "../services/pi/PiSessions";
import { PluginRuntime } from "../services/plugins/PluginRuntime";
import { ProjectSessionLifecycle } from "../services/project-sessions/ProjectSessionLifecycle";
import { ApplicationState } from "../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../services/storage/SessionArchiveStorage";
import type { SubagentCoordinator } from "../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../services/subagents/SubagentEnvironment";
import type { CakeChatEnvironment } from "../services/cake-chats/CakeChatEnvironment";
import {
  CakeChatEnvironmentError,
  makeCakeChatEnvironmentLayer,
} from "../services/cake-chats/CakeChatEnvironment";

interface CakeChatArchiveLocation {
  readonly cwd: string;
  readonly activeRoot: string;
  readonly resolvedRoot: string;
  readonly direct: true;
}

export interface CakeChatEnvironmentLiveOptions {
  readonly homeDirectory: string;
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
}

const environmentError = (operation: string, cause: unknown) =>
  new CakeChatEnvironmentError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeCakeChatEnvironmentLive = (
  options: CakeChatEnvironmentLiveOptions,
): Layer.Layer<
  CakeChatEnvironment,
  never,
  | ApplicationState
  | PiSessions
  | PluginRuntime
  | ProjectSessionLifecycle
  | SessionArchiveStorage
  | SubagentCoordinator
  | SubagentEnvironment
> => {
  const archiveLocation: CakeChatArchiveLocation = {
    cwd: options.homeDirectory,
    activeRoot: options.sessionDirectory,
    resolvedRoot: options.resolvedSessionDirectory,
    direct: true,
  };
  return Layer.unwrap(
    Effect.gen(function* () {
      const application = yield* ApplicationState;
      const lifecycle = yield* ProjectSessionLifecycle;
      const plugins = yield* PluginRuntime;
      const storage = yield* SessionArchiveStorage;
      const context = yield* Effect.context<
        ApplicationState | PiSessions | SubagentCoordinator | SubagentEnvironment
      >();
      const run = Effect.runPromiseWith(context);
      const agentControl = makeSubagentControl({
        runEffect: (effect, signal) => run(effect, { signal }),
      });
      const modelPresets = () => {
        const state = application.snapshot();
        return {
          presets: state.modelPresets.map(({ id, name, modelId }) => ({ id, name, modelId })),
          defaultPresetId: state.defaultModelPresetId,
        };
      };
      return makeCakeChatEnvironmentLayer({
        location: Effect.fn("CakeChatEnvironment.location")(() =>
          Effect.succeed({
            workingDirectory: options.homeDirectory,
            sessionDirectory: options.sessionDirectory,
            resolvedSessionDirectory: options.resolvedSessionDirectory,
          }),
        ),
        runtimeOptions: Effect.fn("CakeChatEnvironment.runtimeOptions")((input, invoke) =>
          Effect.sync(() => {
            const getRuntimeOptions = () => runtimeOptions;
            const runtimeOptions = {
              profile: { _tag: "CakeChatSession" as const },
              runtime: {
                cwd: options.homeDirectory,
                trusted: true,
                agentDir: options.agentDirectory,
                sessionDir: options.sessionDirectory,
                resolvedSessionDir: options.resolvedSessionDirectory,
                newSession: input.newSession,
                sessionId: input.sessionId,
                slashCommands: ["compact", "model", "handoff", "handoffandresolve"],
                requestUi: async () => undefined,
                modelPresets,
                fastMode: {
                  get: () => application.snapshot().fastModeSessionIds.includes(input.sessionId),
                  set: (enabled: boolean) =>
                    run(setSessionFastMode(input.sessionId, enabled)).then(() => undefined),
                },
                currentSessionControl: {
                  resolved: () =>
                    application.snapshot().resolvedCakeChatSessionIds.includes(input.sessionId),
                  setResolved: (resolved: boolean) =>
                    run(lifecycle.setCakeChatResolved(input.sessionId, resolved)).then(
                      () => undefined,
                    ),
                },
                agentControl: agentControl(getRuntimeOptions, options.homeDirectory),
                globalControl: {
                  tools: input.tools.map((tool) => ({
                    ...tool,
                    parameters: Schema.decodeUnknownSync(jsonObjectSchema)(tool.parameters),
                    examples: tool.examples?.map((example) => ({
                      ...example,
                      input:
                        example.input === undefined
                          ? undefined
                          : Schema.decodeUnknownSync(jsonObjectSchema)(example.input),
                    })),
                  })),
                  recoveryContext: plugins.recoveryContext(),
                  invoke: (invocation: Parameters<typeof invoke>[1], signal: AbortSignal) =>
                    invoke(input.sessionId, invocation, signal),
                },
              },
            };
            return runtimeOptions;
          }),
        ),
        archive: Effect.fn("CakeChatEnvironment.archive")((sessionId) =>
          storage
            .resolve(sessionId, archiveLocation)
            .pipe(Effect.mapError((error) => environmentError("archive", error))),
        ),
        restore: Effect.fn("CakeChatEnvironment.restore")((sessionId) =>
          storage
            .restore(sessionId, archiveLocation)
            .pipe(Effect.mapError((error) => environmentError("restore", error))),
        ),
        deleteResolved: Effect.fn("CakeChatEnvironment.deleteResolved")((sessionId) =>
          storage
            .deleteResolved(sessionId, archiveLocation)
            .pipe(Effect.mapError((error) => environmentError("deleteResolved", error))),
        ),
      });
    }),
  );
};
