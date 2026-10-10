import { Effect, Schema } from "effect";
import { resolveCakeModelSelection } from "../model-presets/cake-model-selection";
import { setSessionFastMode } from "../application/application";
import { PiModels } from "../../services/pi/PiModels";
import { defaultCakeChatPreferences } from "./cake-chat-preferences";
import { utilityModelSelection } from "../utility-work/utilityWork";
import type { CakeChatTarget } from "../../ipc/cake-chat-data";
import type { CakeChatLocation } from "./cakeChatLocations";
import { makeSubagentControl } from "../subagents/subagentControl";
import { jsonObjectSchema } from "../../ipc/json-contract";
import type { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import type { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { RendererRequestCoordinator as RendererRequests } from "../../services/renderer-requests/RendererRequestCoordinator";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import type { CakeSessionRuntimeAcquireOptions } from "../../services/pi/CakeSessionRuntimes";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";

const CAKE_CHAT_OPERATIONS = [
  "app.state",
  "app.user-selection",
  "models.list",
  "session.info",
  "session.usage",
  "session.set-model",
  "context.status",
  "context.compact",
  "sessions.list",
  "sessions.info",
  "sessions.open",
  "sessions.create",
  "sessions.send",
  "sessions.reply",
  "sessions.thread",
  "sessions.close-thread",
  "sessions.abort",
  "sessions.rename",
  "sessions.resolve",
  "sessions.pending",
  "sessions.reorder",
  "sessions.cancel-queued",
  "sessions.steer-queued",
  "sessions.send-now",
  "sessions.clear-queue",
  "sessions.schedule",
  "sessions.scheduled",
  "sessions.cancel-scheduled",
  "session-labels.list",
  "sessions.set-labels",
  "subagents.start",
  "subagents.follow-up",
  "subagents.abort",
  "subagents.close",
  "notifications.send",
] as const;

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
  const models = yield* PiModels;
  const catalogs = yield* SessionCatalogChanges;
  const rendererRequests = yield* RendererRequests;
  const context = yield* Effect.context<
    | ApplicationState
    | PiModels
    | CakeSessionRuntimes
    | RendererRequestCoordinator
    | SessionArchiveStorage
    | SessionCatalogChanges
    | SubagentCoordinator
    | SubagentEnvironment
  >();
  const run = makePiCallbackExecutor(context);
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
  const runtimeOptions: CakeSessionRuntimeAcquireOptions = {
    profile: { _tag: "CakeChatSession" },
    onSessionChanged: catalogs.publish({
      _tag: "CakeChatSessionChanged",
      sessionId: target.sessionId,
      resolved: false,
    }),
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
      // Pin the complete Cake Chat toolset instead of relying on Pi's default-tool
      // selection, which does not necessarily activate extension tools.
      tools: ["cake", "zoom", "date"],
      allowedCakeOperations: CAKE_CHAT_OPERATIONS,
      cakeChatMemory: {
        preferences: () =>
          application.snapshot().cakeChatPreferences ?? defaultCakeChatPreferences(),
        summarize: (input) => {
          const state = application.snapshot();
          const model = state.cakeChatPreferences?.summarizationModel ?? state.utilityModel;
          if (!model)
            return Promise.reject(
              new Error(
                "Configure a utility model or Cake Chat summarization model in Settings to continue.",
              ),
            );
          return run(
            models.complete({
              selection: utilityModelSelection(model),
              instructions: input.instructions,
              context: input.context,
              maximumOutputCharacters: 4_096,
              timeoutMs: 120_000,
            }),
            { signal: input.signal },
          );
        },
      },
      slashCommands: ["compact", "model"],
      requestUi: async () => undefined,
      modelPresets,
      resolveModelSelection: (selection, inherited) =>
        resolveCakeModelSelection(selection, modelPresets(), inherited),
      fastMode: {
        get: () => application.snapshot().fastModeSessionIds.includes(target.sessionId),
        set: (enabled) => run(setSessionFastMode(target.sessionId, enabled)).then(() => undefined),
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
