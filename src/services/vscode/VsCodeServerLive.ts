import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { BrowserWindow } from "electron";
import {
  Deferred,
  Effect,
  FiberMap,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  ScopedCache,
  Stream,
  SubscriptionRef,
  type Scope,
} from "effect";
import { ApplicationState } from "../storage/ApplicationState";
import { ProjectAccess } from "../projects/ProjectAccess";
import { CAKE_TITLE_BAR_HEIGHT, Electron, VSCODE_TITLE_BAR_HEIGHT } from "../electron/Electron";
import type { CompanionManifest } from "./VsCodeServerRuntime";
import { VSCODE_SERVER_IDLE_TTL, VsCodeServerRuntime } from "./VsCodeServerRuntime";
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

/** Layer-scoped single-flight whose callers may cancel their own wait independently. */
export const makeInstallSingleFlight = <E>(
  install: Effect.Effect<void, E>,
): Effect.Effect<Effect.Effect<void, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const inFlight = yield* Ref.make<Option.Option<Deferred.Deferred<void, E>>>(Option.none());

    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<void, E>();
        const [deferred, ownsInstall] = yield* Ref.modify(
          inFlight,
          (
            current,
          ): readonly [
            readonly [Deferred.Deferred<void, E>, boolean],
            Option.Option<Deferred.Deferred<void, E>>,
          ] =>
            Option.match(current, {
              onNone: () => [[candidate, true], Option.some(candidate)],
              onSome: (active) => [[active, false], current],
            }),
        );
        if (ownsInstall)
          yield* Effect.exit(install).pipe(
            Effect.flatMap((exit) => Deferred.done(deferred, exit)),
            Effect.ensuring(Ref.set(inFlight, Option.none())),
            Effect.forkIn(scope),
          );
        yield* restore(Deferred.await(deferred));
      }),
    );
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
        ReturnType<VsCodeServerRuntime["snapshotState"]>
      >({
        status: "missing" as const,
        ...(initialCustomPath ? { customPath: initialCustomPath } : null),
      });
      // VsCodeServerRuntime reports state synchronously from native callbacks
      // methods. Queue every transition losslessly and let this Layer's Scope
      // own the ordered Effect consumer.
      const stateChanges =
        yield* Queue.unbounded<ReturnType<VsCodeServerRuntime["snapshotState"]>>();
      yield* Stream.fromQueue(stateChanges).pipe(
        Stream.runForEach((state) => SubscriptionRef.set(editorState, state)),
        Effect.forkScoped,
      );
      const runEviction = yield* FiberMap.makeRuntime<never, string>();
      const runPoll = yield* FiberMap.makeRuntimePromise<never, string>();
      const runAcquisition = yield* FiberMap.makeRuntimePromise<never, string>();
      const runtimeReady = yield* Deferred.make<VsCodeServerRuntime>();
      const servers = yield* ScopedCache.make({
        // Runtime policy keeps three viewer-less servers; this outer bound avoids
        // evicting a server still leased by one of Cake's native views.
        capacity: 64,
        lookup: Effect.fn("VsCodeServer.acquireServer")(function* (key: string) {
          const runtime = yield* Deferred.await(runtimeReady);
          const separator = key.indexOf("\0");
          if (separator < 0) return yield* Effect.die("Invalid VS Code server cache key");
          return yield* Effect.acquireRelease(
            Effect.tryPromise((signal) =>
              runtime.startServer(key.slice(0, separator), key.slice(separator + 1), signal),
            ),
            (instance) => Effect.sync(() => runtime.releaseServer(instance)),
          );
        }),
      });
      let callbackSequence = 0;
      const runtime = new VsCodeServerRuntime({
        root: options.root,
        companionManifest: options.companionManifest,
        companionMain: options.companionMain,
        companionThemes: [...options.companionThemes],
        customPath: () => applicationState.snapshot().vscodeServerPath,
        preferredTheme: options.preferredTheme,
        broadcast: electron.broadcast,
        stateChanged: (state) => {
          Queue.offerUnsafe(stateChanges, state);
        },
        scheduleIdleEviction: (key) => {
          runEviction(
            key,
            Effect.sleep(VSCODE_SERVER_IDLE_TTL).pipe(
              Effect.andThen(ScopedCache.invalidate(servers, key)),
            ),
          );
        },
        cancelIdleEviction: (key) => {
          runEviction(key, Effect.void);
        },
        invalidateServer: (key) => {
          runEviction(key, ScopedCache.invalidate(servers, key));
        },
        pollUntil: (key, check, interval, timeout, failure, signal) =>
          runPoll(
            `${key}:${callbackSequence++}`,
            Effect.suspend(() => {
              const value = check();
              return value === undefined ? Effect.fail(undefined) : Effect.succeed(value);
            }).pipe(
              Effect.retry(Schedule.spaced(interval).pipe(Schedule.upTo({ duration: timeout }))),
              Effect.mapError(() => new Error(failure)),
            ),
            signal ? { signal } : undefined,
          ),
        evictServer: (key) =>
          runAcquisition(`evict:${callbackSequence++}`, ScopedCache.invalidate(servers, key)),
        acquireServer: (workspacePath, binary, signal) =>
          runAcquisition(
            `server:${callbackSequence++}`,
            ScopedCache.get(servers, `${workspacePath}\0${binary}`),
            signal ? { signal } : undefined,
          ),
      });
      yield* Deferred.succeed(runtimeReady, runtime);
      yield* electron.fullscreenSurfaceChanges().pipe(
        Stream.runForEach(({ connectionId, open }) =>
          Effect.sync(() => runtime.setFullscreenSurfaceOpen(connectionId, open)),
        ),
        Effect.forkScoped,
      );

      const tryNative = <A>(operation: string, execute: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
          try: execute,
          catch: (cause) => vscodeError(operation, cause),
        });
      const runInstall = yield* makeInstallSingleFlight(
        tryNative("install", () => runtime.ensureInstalled()).pipe(
          Effect.tap(() => Effect.sync(() => runtime.setStatus("ready"))),
          Effect.tapError((error) => Effect.sync(() => runtime.setStatus("failed", error.message))),
          Effect.asVoid,
        ),
      );
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
        tryNative("updateTheme", (signal) => runtime.updateTheme(signal)),
      );
      const themeUpdates = yield* Queue.unbounded<void>();
      yield* Stream.fromQueue(themeUpdates).pipe(
        Stream.runForEach(() =>
          updateTheme().pipe(
            Effect.tapError((error) => Effect.logError("VsCodeServer.themeUpdateFailed", error)),
            Effect.ignore,
          ),
        ),
        Effect.forkScoped,
      );
      const unsubscribeTheme = options.onThemeUpdated(() => {
        Queue.offerUnsafe(themeUpdates, undefined);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribeTheme();
          runtime.disposeAll();
        }),
      );

      return VsCodeServer.of({
        state: Effect.fn("VsCodeServer.state")(() =>
          Effect.sync(() => ({ ...runtime.snapshotState() })),
        ),
        stateChanges: () => SubscriptionRef.changes(editorState),
        refreshStatus: Effect.fn("VsCodeServer.refreshStatus")(() =>
          tryNative("refreshStatus", () => runtime.refreshStatus()),
        ),
        install: Effect.fn("VsCodeServer.install")(function* (request) {
          yield* runInstall;
          return { requestId: request.requestId };
        }),
        open: Effect.fn("VsCodeServer.open")(function* (connectionId, request) {
          yield* requireAllowed(request.workspacePath);
          const sender = yield* Effect.try({
            try: () => electron.requireRendererConnection(connectionId),
            catch: (cause) => vscodeError("open", cause),
          });
          yield* tryNative("open", (signal) =>
            runtime.open(
              sender.id,
              () => BrowserWindow.fromWebContents(sender),
              request.workspacePath,
              signal,
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
              runtime.updateBounds(sender.id, request);
              return { requestId: request.requestId };
            },
            catch: (cause) => vscodeError("updateBounds", cause),
          }),
        ),
        reveal: Effect.fn("VsCodeServer.reveal")(function* (request) {
          yield* requireAllowed(request.workspacePath);
          const { workspace, target } = yield* tryNative("reveal", () =>
            resolveSourceTarget(request.workspacePath, request.location.path),
          );
          yield* tryNative("reveal", (signal) =>
            runtime.reveal(
              workspace,
              {
                ...request.location,
                path: relative(workspace, target),
              },
              signal,
            ),
          );
          return { requestId: request.requestId };
        }),
        openSourceControl: Effect.fn("VsCodeServer.openSourceControl")(function* (request) {
          yield* requireAllowed(request.workspacePath);
          yield* tryNative("openSourceControl", (signal) =>
            runtime.openSourceControl(request.workspacePath, signal),
          );
          return { requestId: request.requestId };
        }),
        updateAnnotations: Effect.fn("VsCodeServer.updateAnnotations")(function* (request) {
          yield* requireAllowed(request.workspacePath);
          const normalized = yield* tryNative("updateAnnotations", async () => {
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
          yield* tryNative("updateAnnotations", (signal) =>
            runtime.updateAnnotations(
              normalized.workspace,
              {
                sessionId: request.snapshot.sessionId,
                annotations: normalized.annotations,
              },
              signal,
            ),
          );
          return { requestId: request.requestId };
        }),
        enterProjectEditor: Effect.fn("VsCodeServer.enterProjectEditor")(
          function* (workingDirectory) {
            yield* requireAllowed(workingDirectory);
            yield* tryNative("enterProjectEditor", async (signal) => {
              signal.throwIfAborted();
              const candidates = electron.windowsForWorkspace(workingDirectory);
              const selected =
                candidates.find(([, window]) => window.isFocused()) ?? candidates.at(0);
              if (!selected) throw new Error("No Cake window has this project open");
              const [ownerId, window] = selected;
              await runtime.open(ownerId, () => window, workingDirectory, signal);
              signal.throwIfAborted();
              electron.sendTo(window.webContents, {
                type: "embedded-editor-entered",
                workspacePath: workingDirectory,
              });
              await runtime.waitUntilVisible(workingDirectory, signal);
              signal.throwIfAborted();
            });
          },
        ),
        openProjectLocation: Effect.fn("VsCodeServer.openProjectLocation")(
          function* (workingDirectory, location) {
            yield* requireAllowed(workingDirectory);
            return yield* tryNative("openProjectLocation", async (signal) => {
              signal.throwIfAborted();
              if (!(await runtime.isVisible(workingDirectory)))
                return { status: "mode-required" as const };
              const { workspace, target } = await resolveSourceTarget(
                workingDirectory,
                location.path,
              );
              const normalized = {
                ...location,
                path: relative(workspace, target).split(sep).join("/"),
              };
              signal.throwIfAborted();
              await runtime.reveal(workspace, normalized, signal);
              return { status: "completed" as const, value: normalized };
            });
          },
        ),
        runProjectScript: Effect.fn("VsCodeServer.runProjectScript")(
          function* (workingDirectory, source, input) {
            yield* requireAllowed(workingDirectory);
            return yield* tryNative("runProjectScript", async (signal) => {
              signal.throwIfAborted();
              if (!(await runtime.isVisible(workingDirectory)))
                return { status: "mode-required" as const };
              const value = await runtime.runScript(workingDirectory, source, input, signal);
              signal.throwIfAborted();
              return { status: "completed" as const, value };
            });
          },
        ),
        closeForWindow: Effect.fn("VsCodeServer.closeForWindow")((ownerId) =>
          Effect.sync(() => runtime.closeForWindow(ownerId)),
        ),
        backToAgentForWindow: (ownerId) => runtime.backToAgentForWindow(ownerId),
        updateTheme,
      });
    }),
  );
