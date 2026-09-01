import { Effect, Layer } from "effect";
import { resolveAgentModel } from "../domain/pluginAgents";
import type { CakePaths } from "../config/CakePaths";
import type { BoundedCompletionInput } from "../services/pi/model-data";
import { PiModels } from "../services/pi/PiModels";
import { PiPluginAgents } from "../services/pi/PiPluginAgents";
import { PiSessions } from "../services/pi/PiSessions";
import { ProjectSessionIntegrations } from "../services/pi/ProjectSessionIntegrations";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ApplicationState } from "../services/storage/ApplicationState";
import { Electron } from "../services/electron/Electron";
import { PluginHost, type PluginHostOptions } from "../services/plugins/PluginHost";
import { PluginResources } from "../services/plugins/PluginResources";
import {
  PluginRuntime,
  PluginRuntimeError,
  type PluginPromiseOperations,
} from "../services/plugins/PluginRuntime";

export interface PluginRuntimeLiveOptions {
  readonly paths: CakePaths;
  readonly authoringRoot: string;
  readonly applicationRoot: string;
  readonly backendHostPath: string;
  readonly publishInlineWidget: PluginHostOptions["publishInlineWidget"];
}

const operation = <Payload, Success>(
  name: string,
  execute: (connectionId: number, payload: Payload) => Promise<Success>,
): ((connectionId: number, payload: Payload) => Effect.Effect<Success, PluginRuntimeError>) =>
  Effect.fn(name)((connectionId, payload) =>
    Effect.tryPromise({
      try: () => execute(connectionId, payload),
      catch: (cause) =>
        new PluginRuntimeError({ message: cause instanceof Error ? cause.message : String(cause) }),
    }),
  );

export const makePluginRuntimeLive = (
  options: PluginRuntimeLiveOptions,
): Layer.Layer<
  PluginRuntime,
  never,
  | ApplicationState
  | Electron
  | PiModels
  | PiPluginAgents
  | PiSessions
  | ProjectAccess
  | ProjectSessionIntegrations
  | PluginResources
> =>
  Layer.effect(
    PluginRuntime,
    Effect.gen(function* () {
      const application = yield* ApplicationState;
      const electron = yield* Electron;
      const models = yield* PiModels;
      const pluginAgents = yield* PiPluginAgents;
      const sessions = yield* PiSessions;
      const access = yield* ProjectAccess;
      const integrations = yield* ProjectSessionIntegrations;
      const resources = yield* PluginResources;
      const context = yield* Effect.context<
        PiModels | PiSessions | ProjectAccess | ProjectSessionIntegrations | PluginResources
      >();
      const run = Effect.runPromiseWith(context);

      const hostOptions: PluginHostOptions = {
        ...options,
        utilityModel: () => application.snapshot().utilityModel,
        completeModel: (input: BoundedCompletionInput, signal?: AbortSignal) =>
          run(models.complete(input), { signal }),
        driver: pluginAgents.driver,
        resolveAgentModel,
        resolveSessionWorkspacePath: (sessionId) =>
          run(access.resolveSessionWorkingDirectory(sessionId)),
        requireRendererConnection: electron.requireRendererConnection,
        isWorkingDirectoryAllowed: (workingDirectory) =>
          Effect.runSync(access.isAllowed(workingDirectory)),
        emitToRenderer: electron.sendTo,
        broadcast: electron.broadcast,
        refreshApplicationContext: () => {
          void run(sessions.reloadCakeChatContext()).catch((error) =>
            console.error("[cake] Cake Chat context refresh failed", error),
          );
        },
        reloadAll: (renderer) => setTimeout(() => electron.reloadAll(renderer), 100),
        reloadWindowWithFactory: electron.reloadWindowWithFactory,
        resourcesChanged: (next) =>
          run(
            Effect.gen(function* () {
              yield* resources.replace(next);
              yield* sessions.reloadAll();
              yield* integrations.reloadAgentResources();
            }),
          ),
      };
      const host = new PluginHost(hostOptions);
      yield* Effect.addFinalizer(() => Effect.sync(() => host.dispose()));
      const operations: PluginPromiseOperations = host.operations;
      const service = {
        "get-customization-state": operation(
          "PluginRuntime.getCustomizationState",
          operations["get-customization-state"],
        ),
        "get-plugin-authoring-reference": operation(
          "PluginRuntime.getAuthoringReference",
          operations["get-plugin-authoring-reference"],
        ),
        "list-plugin-files": operation("PluginRuntime.listFiles", operations["list-plugin-files"]),
        "create-plugin": operation("PluginRuntime.create", operations["create-plugin"]),
        "read-plugin-file": operation("PluginRuntime.readFile", operations["read-plugin-file"]),
        "write-plugin-file": operation("PluginRuntime.writeFile", operations["write-plugin-file"]),
        "validate-customization": operation(
          "PluginRuntime.validate",
          operations["validate-customization"],
        ),
        "activate-customization": operation(
          "PluginRuntime.activate",
          operations["activate-customization"],
        ),
        "rollback-customization": operation(
          "PluginRuntime.rollback",
          operations["rollback-customization"],
        ),
        "use-factory-customization": operation(
          "PluginRuntime.useFactory",
          operations["use-factory-customization"],
        ),
        "list-plugins": operation("PluginRuntime.list", operations["list-plugins"]),
        "set-plugin-enabled": operation(
          "PluginRuntime.setEnabled",
          operations["set-plugin-enabled"],
        ),
        "set-active-scene": operation(
          "PluginRuntime.setActiveScene",
          operations["set-active-scene"],
        ),
        "delete-plugin": operation("PluginRuntime.delete", operations["delete-plugin"]),
        "compile-inline-widget": operation(
          "PluginRuntime.compileInlineWidget",
          operations["compile-inline-widget"],
        ),
        "repair-inline-widget": operation(
          "PluginRuntime.repairInlineWidget",
          operations["repair-inline-widget"],
        ),
        "open-plugin-agent": operation("PluginRuntime.openAgent", operations["open-plugin-agent"]),
        "prompt-plugin-agent": operation(
          "PluginRuntime.promptAgent",
          operations["prompt-plugin-agent"],
        ),
        "abort-plugin-agent": operation(
          "PluginRuntime.abortAgent",
          operations["abort-plugin-agent"],
        ),
        "detach-plugin-agent": operation(
          "PluginRuntime.detachAgent",
          operations["detach-plugin-agent"],
        ),
        "run-plugin-completion": operation(
          "PluginRuntime.runCompletion",
          operations["run-plugin-completion"],
        ),
        "cancel-plugin-completion": operation(
          "PluginRuntime.cancelCompletion",
          operations["cancel-plugin-completion"],
        ),
        "load-plugin-state": operation("PluginRuntime.loadState", operations["load-plugin-state"]),
        "save-plugin-state": operation("PluginRuntime.saveState", operations["save-plugin-state"]),
        "call-plugin-backend": operation(
          "PluginRuntime.callBackend",
          operations["call-plugin-backend"],
        ),
        "cancel-plugin-backend-call": operation(
          "PluginRuntime.cancelBackendCall",
          operations["cancel-plugin-backend-call"],
        ),
        "customization-rendered": operation(
          "PluginRuntime.reportRendered",
          operations["customization-rendered"],
        ),
        "customization-runtime-failed": operation(
          "PluginRuntime.reportRuntimeFailure",
          operations["customization-runtime-failed"],
        ),
        start: Effect.fn("PluginRuntime.start")(() =>
          Effect.tryPromise({
            try: () => host.start(),
            catch: (cause) =>
              new PluginRuntimeError({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
        ),
        startupRenderer: () => host.startupRenderer(),
        trackRenderer: (ownerId: number, renderer: ReturnType<PluginHost["startupRenderer"]>) =>
          host.trackRenderer(ownerId, renderer),
        rendererProcessGone: (ownerId: number, reason: string) =>
          host.rendererProcessGone(ownerId, reason),
        disposeOwner: (ownerId: number) => host.disposeOwner(ownerId),
        recoveryContext: () => host.recoveryContext(),
        agentResources: () => host.agentResources,
      } satisfies PluginRuntime["Service"];
      return PluginRuntime.of(service);
    }),
  );
