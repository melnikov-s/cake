import type { App } from "electron";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { makeCakeIpcServerLive, type CakeIpcServerOperations } from "../ipc/server/CakeIpcServer";
import { BootstrapLive } from "./BootstrapLive";
import { MainApplication, type MainApplicationHooks } from "./MainApplication";

const makeMainLive = (rpcOperations: CakeIpcServerOperations) =>
  Layer.mergeAll(BootstrapLive, makeCakeIpcServerLive(rpcOperations));

export interface LaunchMainApplicationOptions extends MainApplicationHooks {
  readonly application: App;
  readonly rpcOperations: CakeIpcServerOperations;
}

let launched = false;

export function launchMainApplication(options: LaunchMainApplicationOptions): void {
  if (launched) throw new Error("Cake main application was launched more than once");
  launched = true;
  // The main process has exactly one Effect runtime. Feature modules use this
  // application graph rather than constructing parallel runtimes.
  const mainRuntime = ManagedRuntime.make(makeMainLive(options.rpcOperations));
  void mainRuntime
    .runPromiseExit(
      MainApplication(options).pipe(
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
