import type { Event } from "electron";
import { Deferred, Effect } from "effect";
import type * as Cause from "effect/Cause";
import { initialize } from "../domain/application";
import * as sessionTerminals from "../domain/sessionTerminals";
import { Electron } from "../services/electron/Electron";
import { ProjectSessionIntegrations } from "../services/pi/ProjectSessionIntegrations";
import type { PiSessions } from "../services/pi/PiSessions";
import { PluginRuntime } from "../services/plugins/PluginRuntime";
import { ProjectSessionLifecycle } from "../services/project-sessions/ProjectSessionLifecycle";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { RewordingRequests } from "../services/projects/RewordingRequests";
import { ApplicationState } from "../services/storage/ApplicationState";
import type { Terminal } from "../services/terminal/Terminal";
import { VsCodeServer } from "../services/vscode/VsCodeServer";
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
  | PluginRuntime
  | ProjectAccess
  | ProjectSessionIntegrations
  | ProjectSessionLifecycle
  | RewordingRequests
  | Terminal
  | VsCodeServer;

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
      const integrations = yield* ProjectSessionIntegrations;
      const lifecycle = yield* ProjectSessionLifecycle;
      const plugins = yield* PluginRuntime;
      const access = yield* ProjectAccess;
      const rewordingRequests = yield* RewordingRequests;
      const vscode = yield* VsCodeServer;
      const context = yield* Effect.context<MainApplicationServices>();
      const run = Effect.runPromiseWith(context);

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
      yield* vscode.refreshStatus();
      yield* Effect.sync(initializeNativeProtocols);
      yield* plugins.initializeCustomization();
      yield* lifecycle.reconcile();
      yield* electron.start({
        startupRenderer: plugins.startupRenderer,
        trackRenderer: plugins.trackRenderer,
        rendererProcessGone: plugins.rendererProcessGone,
        disposePluginOwner: plugins.disposeOwner,
        closeTerminalOwner: (ownerId) => {
          void run(sessionTerminals.closeOwner(ownerId));
        },
        closeEditorForWindow: (ownerId) => {
          void run(vscode.closeForWindow(ownerId));
        },
        backToAgentForWindow: (ownerId) => Effect.runSync(vscode.backToAgentForWindow(ownerId)),
        onWindowClosed: (ownerId, workingDirectory) => {
          void run(
            Effect.gen(function* () {
              yield* access.clearOwner(ownerId);
              yield* rewordingRequests.disposeOwner(ownerId);
              if (workingDirectory) yield* integrations.cancelPendingRequests(workingDirectory);
            }),
          );
        },
        allowProjectPath: (path) => {
          Effect.runSync(access.allow(path));
        },
        hasUtilityModel: () => Boolean(applicationState.snapshot().utilityModel),
      });
      yield* Effect.logInfo("Cake main application started");
      yield* Deferred.await(shutdownRequested);
      yield* Effect.logInfo("Cake main application stopping");
    }),
  );
  return yield* program.pipe(Effect.tapCause((cause) => Effect.sync(() => reportDefect?.(cause))));
});
