import type { Event } from "electron";
import { Cause, Deferred, Effect, Queue, Stream } from "effect";
import { initialize } from "../domain/application/application";
import { initializeRegisteredProjectAccess } from "../domain/projects/projects";
import * as workingDirectoryTerminals from "../domain/terminals/workingDirectoryTerminals";
import { Electron } from "../services/electron/Electron";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import type { PiSessions } from "../services/pi/PiSessions";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { RewordingRequests } from "../services/projects/RewordingRequests";
import { ApplicationState } from "../services/storage/ApplicationState";
import type { Terminal } from "../services/terminal/Terminal";
import { VsCodeServer } from "../services/vscode/VsCodeServer";
import type { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import { handleInlineWidgetScheme } from "../services/widgets/inline-widget-protocol";

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
}

type MainApplicationServices =
  | ApplicationState
  | Electron
  | PiSessions
  | ProjectAccess
  | RendererRequestCoordinator
  | RewordingRequests
  | Terminal
  | VsCodeServer
  | ManagedWorktrees;

/** Owns Electron startup, native callbacks, and process-lifetime shutdown. */
export const MainApplication = Effect.fn("MainApplication")(function* ({
  application,
  platform = process.platform,
  reportDefect,
  initializeNativeProtocols = handleInlineWidgetScheme,
}: MainApplicationOptions): Effect.fn.Return<void, unknown, MainApplicationServices> {
  yield* Effect.annotateCurrentSpan({
    "cake.application": "main",
    "cake.process": "electron-main",
  });

  const program = Effect.scoped(
    Effect.gen(function* () {
      const applicationState = yield* ApplicationState;
      const electron = yield* Electron;
      const rendererRequests = yield* RendererRequestCoordinator;
      const access = yield* ProjectAccess;
      const rewordingRequests = yield* RewordingRequests;
      const vscode = yield* VsCodeServer;
      const windowClosed = yield* Queue.unbounded<{
        readonly ownerId: number;
        readonly workingDirectory: string | undefined;
      }>();
      const handleWindowClosed = Effect.fn("MainApplication.handleWindowClosed")(function* ({
        ownerId,
      }: {
        readonly ownerId: number;
        readonly workingDirectory: string | undefined;
      }) {
        yield* Effect.all(
          [
            workingDirectoryTerminals.closeOwner(ownerId),
            vscode.closeForWindow(ownerId),
            access.clearOwner(ownerId),
            rewordingRequests.disposeOwner(ownerId),
            rendererRequests.releaseConnection(ownerId),
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
        if (platform !== "darwin") application.quit();
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => application.on("window-all-closed", onWindowAllClosed)),
        () => Effect.sync(() => application.removeListener("window-all-closed", onWindowAllClosed)),
      );

      yield* Effect.promise(() => application.whenReady()).pipe(
        Effect.withSpan("MainApplication.electronReady"),
      );
      yield* initialize();
      yield* initializeRegisteredProjectAccess();
      yield* vscode.refreshStatus();
      yield* Effect.sync(initializeNativeProtocols);
      yield* electron.start({
        backToAgentForWindow: vscode.backToAgentForWindow,
        onWindowClosed: (ownerId, workingDirectory) => {
          Queue.offerUnsafe(windowClosed, { ownerId, workingDirectory });
        },
        allowProjectPath: access.allow,
        hasUtilityModel: () => Boolean(applicationState.snapshot().utilityModel),
      });
      yield* Effect.logInfo("Cake main application started");
      yield* Deferred.await(shutdownRequested);
      yield* Effect.logInfo("Cake main application stopping");
    }),
  );
  return yield* program.pipe(Effect.tapCause((cause) => Effect.sync(() => reportDefect?.(cause))));
});
