import type { Event } from "electron";
import { Deferred, Effect } from "effect";
import type * as Cause from "effect/Cause";

export interface MainApplicationHooks {
  readonly start: () => Promise<void>;
  readonly stop: () => void | Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly reportDefect?: (cause: Cause.Cause<unknown>) => void;
}

interface MainApplicationElectron {
  on(event: "before-quit", listener: (event: Event) => void): void;
  on(event: "window-all-closed", listener: () => void): void;
  removeListener(event: "before-quit", listener: (event: Event) => void): void;
  removeListener(event: "window-all-closed", listener: () => void): void;
  quit(): void;
  whenReady(): Promise<void>;
}

export interface MainApplicationOptions extends MainApplicationHooks {
  readonly application: MainApplicationElectron;
}

const fromHook = Effect.fn("MainApplication.fromHook")((hook: () => void | Promise<void>) =>
  Effect.promise(() => Promise.resolve(hook())),
);

/**
 * Owns Electron's process lifecycle. Electron remains the authority for quit
 * requests; this program owns the process-lifetime Scope and closes it exactly
 * once before allowing the process to exit.
 */
export const MainApplication = Effect.fn("MainApplication")(function* ({
  application,
  platform = process.platform,
  reportDefect,
  start,
  stop,
}: MainApplicationOptions) {
  yield* Effect.annotateCurrentSpan({
    "cake.application": "main",
    "cake.process": "electron-main",
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        fromHook(stop).pipe(Effect.withSpan("MainApplication.finalize")),
      );

      const shutdownRequested = yield* Deferred.make<void>();
      const onBeforeQuit = (event: Event) => {
        event.preventDefault();
        Deferred.doneUnsafe(shutdownRequested, Effect.void);
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => application.on("before-quit", onBeforeQuit)),
        () => Effect.sync(() => application.removeListener("before-quit", onBeforeQuit)),
      );

      const onWindowAllClosed = () => {
        if (platform !== "darwin") application.quit();
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => application.on("window-all-closed", onWindowAllClosed)),
        () => Effect.sync(() => application.removeListener("window-all-closed", onWindowAllClosed)),
      );

      yield* Effect.promise(() => application.whenReady()).pipe(
        Effect.withSpan("MainApplication.electronReady"),
      );
      yield* fromHook(start).pipe(Effect.withSpan("MainApplication.start"));
      yield* Effect.logInfo("Cake main application started");

      yield* Deferred.await(shutdownRequested);
      yield* Effect.logInfo("Cake main application stopping");
    }),
  );

  return yield* program.pipe(Effect.tapCause((cause) => Effect.sync(() => reportDefect?.(cause))));
});
