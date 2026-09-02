import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { BrowserWindow } from "electron";
import { Effect, Layer, SubscriptionRef } from "effect";
import { ApplicationState } from "../storage/ApplicationState";
import { ProjectAccess } from "../projects/ProjectAccess";
import { CAKE_TITLE_BAR_HEIGHT, Electron, VSCODE_TITLE_BAR_HEIGHT } from "../electron/Electron";
import type { CompanionManifest } from "./VsCodeServerManager";
import { VsCodeServerManager } from "./VsCodeServerManager";
import { resolveSourceTarget } from "./source-path-policy";
import { VsCodeServer, VsCodeServerError } from "./VsCodeServer";

export interface VsCodeServerLiveOptions {
  readonly root: string;
  readonly companionManifest: CompanionManifest;
  readonly companionMain: string;
  readonly companionThemes: Array<{ readonly path: string; readonly content: string }>;
  readonly preferredTheme: () => Promise<"light" | "dark">;
  readonly onThemeUpdated: (listener: () => void) => () => void;
}

const vscodeError = (operation: string, cause: unknown) =>
  new VsCodeServerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeVsCodeServerLive = (
  options: VsCodeServerLiveOptions,
): Layer.Layer<VsCodeServer, never, ApplicationState | Electron | ProjectAccess> =>
  Layer.effect(
    VsCodeServer,
    Effect.gen(function* () {
      const applicationState = yield* ApplicationState;
      const electron = yield* Electron;
      const projectAccess = yield* ProjectAccess;
      const initialCustomPath = applicationState.snapshot().vscodeServerPath;
      const editorState = yield* SubscriptionRef.make<
        ReturnType<VsCodeServerManager["snapshotState"]>
      >({
        status: "missing" as const,
        ...(initialCustomPath ? { customPath: initialCustomPath } : null),
      });
      const manager = new VsCodeServerManager({
        root: options.root,
        companionManifest: options.companionManifest,
        companionMain: options.companionMain,
        companionThemes: [...options.companionThemes],
        customPath: () => applicationState.snapshot().vscodeServerPath,
        preferredTheme: options.preferredTheme,
        broadcast: electron.broadcast,
        stateChanged: (state) => Effect.runSync(SubscriptionRef.set(editorState, state)),
      });
      const tryManager = <A>(operation: string, execute: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
          try: execute,
          catch: (cause) => vscodeError(operation, cause),
        });
      const requireAllowed = Effect.fn("VsCodeServer.requireAllowed")(function* (
        workingDirectory: string,
      ) {
        if (!(yield* projectAccess.isAllowed(workingDirectory)))
          return yield* new VsCodeServerError({
            operation: "authorizeWorkingDirectory",
            message: "Project path was not selected by the user",
          });
      });

      const updateTheme = Effect.fn("VsCodeServer.updateTheme")(() =>
        tryManager("updateTheme", () => manager.updateTheme()),
      );
      const unsubscribeTheme = options.onThemeUpdated(() => {
        void manager.updateTheme().catch((error) => {
          console.error("[cake.vscode] Theme update failed", error);
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribeTheme();
          manager.disposeAll();
        }),
      );

      return VsCodeServer.of({
        state: Effect.fn("VsCodeServer.state")(() =>
          Effect.sync(() => ({ ...manager.snapshotState() })),
        ),
        stateChanges: () => SubscriptionRef.changes(editorState),
        refreshStatus: Effect.fn("VsCodeServer.refreshStatus")(() =>
          tryManager("refreshStatus", () => manager.refreshStatus()),
        ),
        install: Effect.fn("VsCodeServer.install")((request) =>
          tryManager("install", async () => {
            await manager.install();
            return { requestId: request.requestId };
          }),
        ),
        open: Effect.fn("VsCodeServer.open")(function* (connectionId, request) {
          yield* requireAllowed(request.workspacePath);
          const sender = yield* Effect.try({
            try: () => electron.requireRendererConnection(connectionId),
            catch: (cause) => vscodeError("open", cause),
          });
          yield* tryManager("open", () =>
            manager.open(
              sender.id,
              () => BrowserWindow.fromWebContents(sender),
              request.workspacePath,
            ),
          );
          return { requestId: request.requestId };
        }),
        updateBounds: Effect.fn("VsCodeServer.updateBounds")((connectionId, request) =>
          Effect.try({
            try: () => {
              const sender = electron.requireRendererConnection(connectionId);
              const window = BrowserWindow.fromWebContents(sender);
              if (window)
                electron.centerTrafficLights(
                  window,
                  request.visible ? VSCODE_TITLE_BAR_HEIGHT : CAKE_TITLE_BAR_HEIGHT,
                );
              manager.updateBounds(sender.id, request);
              return { requestId: request.requestId };
            },
            catch: (cause) => vscodeError("updateBounds", cause),
          }),
        ),
        reveal: Effect.fn("VsCodeServer.reveal")(function* (request) {
          yield* requireAllowed(request.workspacePath);
          const { workspace, target } = yield* tryManager("reveal", () =>
            resolveSourceTarget(request.workspacePath, request.location.path),
          );
          yield* tryManager("reveal", () =>
            manager.reveal(workspace, {
              ...request.location,
              path: relative(workspace, target),
            }),
          );
          return { requestId: request.requestId };
        }),
        openSourceControl: Effect.fn("VsCodeServer.openSourceControl")(function* (request) {
          yield* requireAllowed(request.workspacePath);
          yield* tryManager("openSourceControl", () =>
            manager.openSourceControl(request.workspacePath),
          );
          return { requestId: request.requestId };
        }),
        updateAnnotations: Effect.fn("VsCodeServer.updateAnnotations")(function* (request) {
          yield* requireAllowed(request.workspacePath);
          const normalized = yield* tryManager("updateAnnotations", async () => {
            const workspace = await realpath(request.workspacePath);
            const annotations = await Promise.allSettled(
              request.snapshot.annotations.map(async (annotation) => {
                const { target } = await resolveSourceTarget(workspace, annotation.location.path);
                return {
                  ...annotation,
                  location: {
                    ...annotation.location,
                    path: relative(workspace, target).split(sep).join("/"),
                  },
                };
              }),
            );
            return {
              workspace,
              annotations: annotations.flatMap((item) =>
                item.status === "fulfilled" ? [item.value] : [],
              ),
            };
          });
          yield* tryManager("updateAnnotations", () =>
            manager.updateAnnotations(normalized.workspace, {
              sessionId: request.snapshot.sessionId,
              annotations: normalized.annotations,
            }),
          );
          return { requestId: request.requestId };
        }),
        openProjectLocation: Effect.fn("VsCodeServer.openProjectLocation")(
          function* (workingDirectory, location) {
            yield* requireAllowed(workingDirectory);
            return yield* tryManager("openProjectLocation", async (signal) => {
              signal.throwIfAborted();
              const candidates = electron.windowsForWorkspace(workingDirectory);
              const selected =
                candidates.find(([, window]) => window.isFocused()) ?? candidates.at(0);
              if (!selected) throw new Error("No Cake window has this project open");
              const [ownerId, window] = selected;
              const { workspace, target } = await resolveSourceTarget(
                workingDirectory,
                location.path,
              );
              const normalized = {
                ...location,
                path: relative(workspace, target).split(sep).join("/"),
              };
              signal.throwIfAborted();
              await manager.open(ownerId, () => window, workspace);
              signal.throwIfAborted();
              await manager.reveal(workspace, normalized);
              signal.throwIfAborted();
              electron.sendTo(window.webContents, {
                type: "embedded-editor-location-opened",
                workspacePath: workingDirectory,
                location: normalized,
              });
              return normalized;
            });
          },
        ),
        closeForWindow: Effect.fn("VsCodeServer.closeForWindow")((ownerId) =>
          Effect.sync(() => manager.closeForWindow(ownerId)),
        ),
        backToAgentForWindow: Effect.fn("VsCodeServer.backToAgentForWindow")((ownerId) =>
          Effect.sync(() => manager.backToAgentForWindow(ownerId)),
        ),
        updateTheme,
      });
    }),
  );
