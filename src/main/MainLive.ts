import type { App } from "electron";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { initialize } from "../domain/application";
import { makeCakeIpcServerLive, type CakeIpcServerOperations } from "../ipc/server/CakeIpcServer";
import { ApplicationState } from "../services/storage/ApplicationState";
import { makeApplicationStorageLive } from "../services/storage/ApplicationStorage";
import { BootstrapLive } from "./BootstrapLive";
import { MainApplication, type MainApplicationHooks } from "./MainApplication";

const makeMainLive = (application: App, rpcOperations: CakeIpcServerOperations) => {
  const applicationLive = ApplicationState.layer.pipe(
    Layer.provideMerge(makeApplicationStorageLive(application.getPath("userData"))),
    Layer.provideMerge(BootstrapLive),
  );
  return makeCakeIpcServerLive(rpcOperations).pipe(Layer.provideMerge(applicationLive));
};

export interface LaunchMainApplicationOptions extends Omit<MainApplicationHooks, "start"> {
  readonly application: App;
  readonly rpcOperations: CakeIpcServerOperations;
  readonly start: (applicationState: ApplicationState["Service"]) => Promise<void>;
}

let launched = false;
let runApplicationEffect:
  | (<A, E>(effect: Effect.Effect<A, E, ApplicationState>) => Promise<A>)
  | undefined;

/** Runs migrated Application domain Effects on the one process-lifetime main runtime. */
export function runMainApplicationEffect<A, E>(
  effect: Effect.Effect<A, E, ApplicationState>,
): Promise<A> {
  if (!runApplicationEffect) throw new Error("Cake main runtime is not available");
  return runApplicationEffect(effect);
}

export function launchMainApplication(options: LaunchMainApplicationOptions): void {
  if (launched) throw new Error("Cake main application was launched more than once");
  launched = true;
  // The main process has exactly one Effect runtime. Feature modules use this
  // application graph rather than constructing parallel runtimes.
  const mainRuntime = ManagedRuntime.make(makeMainLive(options.application, options.rpcOperations));
  runApplicationEffect = (effect) => mainRuntime.runPromise(effect);

  const program = Effect.gen(function* () {
    const applicationState = yield* ApplicationState;
    return yield* MainApplication({
      ...options,
      start: async () => {
        // Corrupt, future, or unmigratable Application documents fail startup.
        // Missing documents alone receive defaults. The source is never overwritten.
        await runMainApplicationEffect(initialize());
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
      runApplicationEffect = undefined;
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
