import type { Event } from "electron";
import { Cause, Deferred, Effect, Option, Queue, Stream } from "effect";
import * as workingDirectoryTerminals from "../domain/terminals/workingDirectoryTerminals";
import { DesktopSharing } from "../services/electron/DesktopSharing";
import { Electron } from "../services/electron/Electron";
import { Browser } from "../services/browser/Browser";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { RewordingRequests } from "../services/projects/RewordingRequests";
import { ApplicationState } from "../services/storage/ApplicationState";
import { Terminal } from "../services/terminal/Terminal";
import { VsCodeServer } from "../services/vscode/VsCodeServer";
import { VsCodeViews } from "../services/vscode/VsCodeViews";
import { handleInlineWidgetScheme } from "../services/electron/inline-widget-protocol";
import { handleExtensionCompanionScheme } from "../services/electron/extension-companion-protocol";

interface MainApplicationElectron {
  on(event: "before-quit", listener: (event: Event) => void): void;
  on(event: "window-all-closed", listener: () => void): void;
  removeListener(event: "before-quit", listener: (event: Event) => void): void;
  removeListener(event: "window-all-closed", listener: () => void): void;
  quit(): void;
  whenReady(): Promise<void>;
}

export interface MainApplicationOptions {
  readonly application: MainApplicationElectron;
  readonly platform?: NodeJS.Platform;
  readonly reportDefect?: (cause: Cause.Cause<unknown>) => void;
  readonly initializeNativeProtocols?: () => void;
  readonly initializeDeveloperTools?: () => Promise<void>;
}

/** Owns Electron startup, native callbacks, and process-lifetime shutdown. */
export const MainApplication = Effect.fn("MainApplication")(function* ({
  application,
  platform = process.platform,
  reportDefect,
  initializeNativeProtocols = () => {
    handleInlineWidgetScheme();
    handleExtensionCompanionScheme();
  },
  initializeDeveloperTools,
}: MainApplicationOptions): Effect.fn.Return<void, unknown, Electron> {
  yield* Effect.annotateCurrentSpan({
    "cake.application": "main",
    "cake.process": "electron-main",
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      const applicationState = yield* Effect.serviceOption(ApplicationState);
      const sharing = yield* Effect.serviceOption(DesktopSharing);
      const browser = yield* Effect.serviceOption(Browser);
      const electron = yield* Electron;
      const rendererRequests = yield* Effect.serviceOption(RendererRequestCoordinator);
      const access = yield* Effect.serviceOption(ProjectAccess);
      const rewordingRequests = yield* Effect.serviceOption(RewordingRequests);
      const vscode = yield* Effect.serviceOption(VsCodeServer);
      const vscodeViews = yield* Effect.serviceOption(VsCodeViews);
      const terminal = yield* Effect.serviceOption(Terminal);
      const windowClosed = yield* Queue.unbounded<{
        readonly nativeId: number;
        readonly ownerId: number;
        readonly workingDirectory: string | undefined;
      }>();
      const handleWindowClosed = Effect.fn("MainApplication.handleWindowClosed")(function* ({
        ownerId,
        nativeId,
      }: {
        readonly nativeId: number;
        readonly ownerId: number;
        readonly workingDirectory: string | undefined;
      }) {
        yield* Effect.all(
          [
            Option.isSome(terminal)
              ? workingDirectoryTerminals
                  .closeOwner(ownerId)
                  .pipe(Effect.provideService(Terminal, terminal.value))
              : Effect.void,
            Option.isSome(browser) ? browser.value.closeForWindow(ownerId) : Effect.void,
            Option.isSome(vscode) ? vscode.value.releaseConnection(ownerId) : Effect.void,
            Option.isSome(vscodeViews) ? vscodeViews.value.closeForWindow(nativeId) : Effect.void,
            Option.isSome(access) ? access.value.clearOwner(ownerId) : Effect.void,
            Option.isSome(rewordingRequests)
              ? rewordingRequests.value.disposeOwner(ownerId)
              : Effect.void,
            Option.isSome(rendererRequests)
              ? rendererRequests.value.releaseConnection(ownerId)
              : Effect.void,
          ],
          { concurrency: "unbounded", discard: true },
        );
      });
      yield* Stream.fromQueue(windowClosed).pipe(
        Stream.runForEach((event) =>
          handleWindowClosed(event).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logError("Window cleanup failed", Cause.pretty(cause)),
            ),
            // Window cleanup operations were independent before this queue;
            // retain that concurrency, including across different windows.
            Effect.forkScoped,
          ),
        ),
        Effect.forkScoped,
      );

      yield* Effect.addFinalizer(() => electron.stop());
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
        if (platform !== "darwin" && !(Option.isSome(sharing) && sharing.value.keepsProcessAlive()))
          application.quit();
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => application.on("window-all-closed", onWindowAllClosed)),
        () => Effect.sync(() => application.removeListener("window-all-closed", onWindowAllClosed)),
      );

      yield* Effect.promise(() => application.whenReady()).pipe(
        Effect.withSpan("MainApplication.electronReady"),
      );
      if (initializeDeveloperTools)
        yield* Effect.tryPromise({
          try: initializeDeveloperTools,
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Unable to install Electron developer tools", cause),
          ),
          Effect.withSpan("MainApplication.initializeDeveloperTools"),
        );
      yield* Effect.sync(initializeNativeProtocols);
      yield* electron.start({
        backToAgentForWindow: (id) =>
          Option.isSome(vscodeViews) && vscodeViews.value.backToAgentForWindow(id),
        onWindowClosed: (ownerId, workingDirectory, nativeId) => {
          Queue.offerUnsafe(windowClosed, { ownerId, workingDirectory, nativeId });
        },
        allowProjectPath: (path) =>
          Option.isSome(access) ? access.value.allow(path) : Effect.void,
        // A remote native host has no application-state authority. Keep the action available;
        // the actual backend reword operation validates its own utility-model configuration.
        canRewordSelection: () =>
          Option.isNone(applicationState) ||
          Boolean(applicationState.value.snapshot().utilityModel),
      });
      yield* Effect.logInfo("Cake main application started");
      yield* Deferred.await(shutdownRequested);
      yield* Effect.logInfo("Cake main application stopping");
    }),
  );
  return yield* program.pipe(Effect.tapCause((cause) => Effect.sync(() => reportDefect?.(cause))));
});
