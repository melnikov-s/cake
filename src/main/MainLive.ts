import type { App } from "electron";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { initialize } from "../domain/application";
import { makeCakeIpcServerLive, type CakeIpcServerOperations } from "../ipc/server/CakeIpcServer";
import type { PiAgentResources } from "../services/pi/PiAgentResources";
import type { PiModels } from "../services/pi/PiModels";
import type { PiSessions } from "../services/pi/PiSessions";
import { makePiAgentResourcesLive } from "../services/pi/live/PiAgentResourcesLive";
import { makePiModelsLive } from "../services/pi/live/PiModelsLive";
import { makePiSessionsLive } from "../services/pi/PiSessions";
import {
  makeProjectSessionEnvironmentLayer,
  type ProjectSessionEnvironment,
} from "../services/project-sessions/ProjectSessionEnvironment";
import { ApplicationState } from "../services/storage/ApplicationState";
import { makeApplicationStorageLive } from "../services/storage/ApplicationStorage";
import { BootstrapLive } from "./BootstrapLive";
import { MainApplication, type MainApplicationHooks } from "./MainApplication";

const makeMainLive = (
  application: App,
  rpcOperations: CakeIpcServerOperations,
  piAgentDirectory: string,
) => {
  const storageLive = makeApplicationStorageLive(application.getPath("userData")).pipe(
    Layer.provide(BootstrapLive),
  );
  const applicationLive = ApplicationState.layer.pipe(Layer.provide(storageLive));
  const servicesLive = Layer.mergeAll(
    applicationLive,
    makePiModelsLive(piAgentDirectory),
    makePiAgentResourcesLive(piAgentDirectory),
    makePiSessionsLive(),
    makeProjectSessionEnvironmentLayer(rpcOperations.projectSessions),
  );
  const serverLive = makeCakeIpcServerLive(rpcOperations).pipe(Layer.provide(servicesLive));
  return Layer.merge(servicesLive, serverLive);
};

export interface LaunchMainApplicationOptions extends Omit<MainApplicationHooks, "start"> {
  readonly application: App;
  readonly rpcOperations: CakeIpcServerOperations;
  readonly piAgentDirectory: string;
  readonly start: (applicationState: ApplicationState["Service"]) => Promise<void>;
}

let launched = false;
type MainService =
  | ApplicationState
  | PiAgentResources
  | PiModels
  | PiSessions
  | ProjectSessionEnvironment;
let runEffect:
  | (<A, E>(effect: Effect.Effect<A, E, MainService>, signal?: AbortSignal) => Promise<A>)
  | undefined;

/** Runs migrated main Effects on the one process-lifetime runtime. */
export function runMainEffect<A, E>(
  effect: Effect.Effect<A, E, MainService>,
  signal?: AbortSignal,
): Promise<A> {
  if (!runEffect) throw new Error("Cake main runtime is not available");
  return runEffect(effect, signal);
}

export function launchMainApplication(options: LaunchMainApplicationOptions): void {
  if (launched) throw new Error("Cake main application was launched more than once");
  launched = true;
  // The main process has exactly one Effect runtime. Feature modules use this
  // application graph rather than constructing parallel runtimes.
  const mainRuntime = ManagedRuntime.make(
    makeMainLive(options.application, options.rpcOperations, options.piAgentDirectory),
  );
  runEffect = (effect, signal) => mainRuntime.runPromise(effect, { signal });

  const program = Effect.gen(function* () {
    const applicationState = yield* ApplicationState;
    return yield* MainApplication({
      ...options,
      start: async () => {
        // Corrupt, future, or unmigratable Application documents fail startup.
        // Missing documents alone receive defaults. The source is never overwritten.
        await runMainEffect(initialize());
        await options.start(applicationState);
      },
    });
  });

  void mainRuntime
    .runPromiseExit(
      program.pipe(
        Effect.tapCause((cause) =>
          Effect.logFatal(
            "Main application terminated with an unhandled defect",
            Cause.pretty(cause),
          ),
        ),
      ),
    )
    .then(async (exit) => {
      let exitCode = Exit.isFailure(exit) ? 1 : 0;
      runEffect = undefined;
      try {
        await mainRuntime.dispose();
      } catch (defect) {
        exitCode = 1;
        console.error("[cake.main] ManagedRuntime finalization failed", defect);
      } finally {
        options.application.exit(exitCode);
      }
    });
}
