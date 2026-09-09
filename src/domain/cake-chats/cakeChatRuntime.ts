import { Effect, Schema } from "effect";
import { setSessionFastMode } from "../application/application";
import type { CakeChatTarget } from "./cake-chat-data";
import * as cakeChatLifecycle from "./cakeChatLifecycle";
import type { CakeChatLocation } from "./cakeChatLocations";
import { makeSubagentControl } from "../subagents/subagentControl";
import { jsonObjectSchema } from "../../ipc/json-contract";
import type { PiSessions } from "../../services/pi/PiSessions";
import type { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { RendererRequestCoordinator as RendererRequests } from "../../services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import type { PiSessionAcquireOptions } from "../../services/pi/PiSessions";

export interface CakeChatRuntimeConfiguration {
  readonly location: CakeChatLocation;
  readonly agentDirectory: string;
}

/** The single Cake-owned composition point for Cake Chat Pi acquisition. */
export const acquireOptions = Effect.fn("CakeChats.acquireOptions")(function* ({
  configuration,
  target,
  newSession,
}: {
  readonly configuration: CakeChatRuntimeConfiguration;
  readonly target: CakeChatTarget;
  readonly newSession: boolean;
}) {
  const application = yield* ApplicationState;
  const catalogs = yield* SessionCatalogChanges;
  const rendererRequests = yield* RendererRequests;
  const context = yield* Effect.context<
    | ApplicationState
    | PiSessions
    | RendererRequestCoordinator
    | SessionArchiveStorage
    | SessionCatalogChanges
    | SubagentCoordinator
    | SubagentEnvironment
  >();
  const run = Effect.runPromiseWith(context);
  const agentControl = makeSubagentControl({
    runEffect: (effect, signal) => run(effect, { signal }),
  });
  const modelPresets = () => {
    const state = application.snapshot();
    return {
      presets: state.modelPresets.map((preset) => ({ ...preset })),
      defaultPresetId: state.defaultModelPresetId,
    };
  };
  const getRuntimeOptions = () => runtimeOptions;
  const runtimeOptions: PiSessionAcquireOptions = {
    profile: { _tag: "CakeChatSession" },
    onRelease: rendererRequests.releaseSession({
      _tag: "CakeChatSession",
      sessionId: target.sessionId,
    }),
    runtime: {
      cwd: configuration.location.workingDirectory,
      trusted: true,
      agentDir: configuration.agentDirectory,
      sessionDir: configuration.location.sessionDirectory,
      resolvedSessionDir: configuration.location.resolvedSessionDirectory,
      newSession,
      sessionId: target.sessionId,
      slashCommands: ["compact", "model", "handoff", "handoffandresolve"],
      requestUi: async () => undefined,
      modelPresets,
      fastMode: {
        get: () => application.snapshot().fastModeSessionIds.includes(target.sessionId),
        set: (enabled) => run(setSessionFastMode(target.sessionId, enabled)).then(() => undefined),
      },
      currentSessionControl: {
        // A Cake Chat runtime is acquired only from the active namespace.
        resolved: () => false,
        setResolved: (resolved) =>
          run(
            cakeChatLifecycle.setResolved(target.sessionId, resolved, configuration.location),
          ).then(() => undefined),
      },
      sessionTitleChanged: (sessionId) =>
        run(
          catalogs.publish({
            _tag: "CakeChatSessionChanged",
            sessionId,
            resolved: false,
          }),
        ),
      agentControl: agentControl(getRuntimeOptions, configuration.location.workingDirectory),
      globalControl: {
        tools: target.tools.map((tool) => ({
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
        // Pi requires a Promise callback; this is the final adapter from the
        // Cake-owned control Effect to the Pi runtime callback contract.
        invoke: (invocation, signal) =>
          run(
            rendererRequests
              .requestCakeChatControl(target.sessionId, invocation, signal)
              .pipe(Effect.orDie),
            { signal },
          ),
      },
    },
  };
  return runtimeOptions;
});
