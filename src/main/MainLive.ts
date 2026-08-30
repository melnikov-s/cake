import type { App } from "electron";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { BootstrapLive } from "./BootstrapLive";
import { MainApplication, type MainApplicationHooks } from "./MainApplication";

const MainLive = Layer.mergeAll(BootstrapLive);

// The main process has exactly one Effect runtime. Feature modules must use
// this runtime through the application graph rather than constructing their own.
const mainRuntime = ManagedRuntime.make(MainLive);

export interface LaunchMainApplicationOptions extends MainApplicationHooks {
  readonly application: App;
}

export function launchMainApplication(options: LaunchMainApplicationOptions): void {
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
