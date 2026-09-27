import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
  type Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Semaphore,
  ScopedCache,
  Stream,
  SubscriptionRef,
  type Scope,
} from "effect";
import { ApplicationState } from "../storage/ApplicationState";
import { ProjectAccess } from "../projects/ProjectAccess";
import { ClientEvents } from "../clients/ClientEvents";
import { ClientConnections } from "../clients/ClientConnections";
import type { CompanionManifest, ServerInstance } from "./VsCodeServerRuntime";
import { VSCODE_SERVER_IDLE_TTL, VsCodeServerRuntime } from "./VsCodeServerRuntime";
import { resolveEditorTarget, resolveSourceTarget } from "./source-path-policy";
import { VsCodeServer, VsCodeServerError } from "./VsCodeServer";

export interface VsCodeServerLiveOptions {
  readonly root: string;
  readonly companionManifest: CompanionManifest;
  readonly companionSource: string;
  readonly companionThemes: Array<{ readonly path: string; readonly content: string }>;
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
): Layer.Layer<
  VsCodeServer,
  never,
  ApplicationState | ClientConnections | ProjectAccess | ClientEvents
> =>
  Layer.effect(
    VsCodeServer,
    Effect.gen(function* () {
      const applicationState = yield* ApplicationState;
      const connections = yield* ClientConnections;
      const acquisitionLock = yield* Semaphore.make(1);
      const clientEvents = yield* ClientEvents;
      const projectAccess = yield* ProjectAccess;
      const initialCustomPath = applicationState.snapshot().vscodeServerPath;
      const editorState = yield* SubscriptionRef.make<
        ReturnType<VsCodeServerRuntime["snapshotState"]>
      >({
        status: "missing" as const,
        ...(initialCustomPath ? { customPath: initialCustomPath } : null),
      });
      // VsCodeServerRuntime reports state synchronously from process/bridge callbacks.
      // Queue every transition losslessly and let this Layer's Scope
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
      const servers = yield* ScopedCache.makeWith<string, ServerInstance, Cause.UnknownError>({
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
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      });
      let callbackSequence = 0;
      const runtime = new VsCodeServerRuntime({
        root: options.root,
        companionManifest: options.companionManifest,
        companionSource: options.companionSource,
        companionThemes: [...options.companionThemes],
        customPath: () => applicationState.snapshot().vscodeServerPath,
        sendTo: clientEvents.sendTo,
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
      const tryServer = <A>(operation: string, execute: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({
          try: execute,
          catch: (cause) => vscodeError(operation, cause),
        });
      const runInstall = yield* makeInstallSingleFlight(
        tryServer("install", () => runtime.ensureInstalled()).pipe(
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

      const requireViewer = Effect.fn("VsCodeServer.requireViewer")(function* (
        connectionId: number,
        workspacePath: string,
      ) {
        yield* requireAllowed(workspacePath);
        const lease = runtime.leaseFor(connectionId);
        if (!lease)
          return yield* new VsCodeServerError({
            operation: "requireViewer",
            message: "This desktop does not own the workspace's editor view",
          });
        const resolved = yield* tryServer("requireViewer", () => realpath(workspacePath));
        if (lease.workspacePath !== resolved)
          return yield* new VsCodeServerError({
            operation: "requireViewer",
            message: "This desktop does not own the workspace's editor view",
          });
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => runtime.disposeAll()));

      return VsCodeServer.of({
        state: Effect.fn("VsCodeServer.state")(() =>
          Effect.sync(() => ({ ...runtime.snapshotState() })),
        ),
        stateChanges: () => SubscriptionRef.changes(editorState),
        refreshStatus: Effect.fn("VsCodeServer.refreshStatus")(() =>
          tryServer("refreshStatus", () => runtime.refreshStatus()),
        ),
        install: Effect.fn("VsCodeServer.install")(function* (request) {
          yield* runInstall;
          return { requestId: request.requestId };
        }),
        acquire: Effect.fn("VsCodeServer.acquire")((connectionId, request) =>
          acquisitionLock.withPermits(1)(
            Effect.suspend(() => {
              const previousLease = runtime.leaseFor(connectionId)?.id;
              return Effect.gen(function* () {
                yield* requireAllowed(request.workspacePath);
                if (connections.kind(connectionId) !== "desktop")
                  return yield* new VsCodeServerError({
                    operation: "acquire",
                    message: "An embedded VS Code view requires a connected desktop",
                  });
                const lease = yield* tryServer("acquire", (signal) =>
                  runtime.acquire(
                    connectionId,
                    request.workspacePath,
                    request.theme,
                    signal,
                    connections.nativeId(connectionId) === undefined,
                  ),
                );
                if (connections.kind(connectionId) !== "desktop") {
                  runtime.releaseConnection(connectionId);
                  return yield* new VsCodeServerError({
                    operation: "acquire",
                    message: "The desktop disconnected while opening VS Code",
                  });
                }
                return lease;
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    const current = runtime.leaseFor(connectionId);
                    if (current && current.id !== previousLease)
                      runtime.releaseLease(connectionId, current.id);
                  }),
                ),
              );
            }),
          ),
        ),
        leaseFor: (connectionId) => runtime.leaseFor(connectionId),
        releaseConnection: Effect.fn("VsCodeServer.releaseConnection")((connectionId) =>
          Effect.sync(() => runtime.releaseConnection(connectionId)),
        ),
        releaseLease: Effect.fn("VsCodeServer.releaseLease")((connectionId, leaseId) =>
          Effect.sync(() => runtime.releaseLease(connectionId, leaseId)),
        ),
        setVisible: Effect.fn("VsCodeServer.setVisible")((connectionId, visible) =>
          Effect.sync(() => runtime.setVisible(connectionId, visible)),
        ),
        setTheme: Effect.fn("VsCodeServer.setTheme")((connectionId, theme) =>
          tryServer("setTheme", (signal) => runtime.setTheme(connectionId, theme, signal)),
        ),
        reveal: Effect.fn("VsCodeServer.reveal")(function* (connectionId, request) {
          yield* requireViewer(connectionId, request.workspacePath);
          const resolved = yield* tryServer("reveal", () =>
            resolveEditorTarget(request.workspacePath, request.location),
          );
          const reveal = yield* tryServer("reveal", (signal) =>
            runtime.reveal(resolved.workspace, resolved.location, signal),
          );
          return { requestId: request.requestId, reveal };
        }),
        updateSelectionHighlights: Effect.fn("VsCodeServer.updateSelectionHighlights")(
          function* (connectionId, request) {
            yield* requireViewer(connectionId, request.workspacePath);
            yield* tryServer("updateSelectionHighlights", async (signal) => {
              // Revalidate paths at the backend boundary; identity and collection policy stay in the Store.
              const locations = await Promise.all(
                request.highlights.locations.map(async (location) => {
                  const resolved = await resolveEditorTarget(
                    request.workspacePath,
                    location.view === "file"
                      ? { kind: location.kind, path: location.path, range: location.range }
                      : location,
                  );
                  return { ...location, path: resolved.location.path };
                }),
              );
              await runtime.updateSelectionHighlights(request.workspacePath, { locations }, signal);
            });
            return { requestId: request.requestId };
          },
        ),
        openSourceControl: Effect.fn("VsCodeServer.openSourceControl")(
          function* (connectionId, request) {
            yield* requireViewer(connectionId, request.workspacePath);
            yield* tryServer("openSourceControl", (signal) =>
              runtime.openSourceControl(request.workspacePath, signal),
            );
            return { requestId: request.requestId };
          },
        ),
        performEditorAction: Effect.fn("VsCodeServer.performEditorAction")(
          function* (connectionId, request) {
            yield* requireViewer(connectionId, request.workspacePath);
            const normalized = yield* tryServer("performEditorAction", async () => {
              const action = request.action;
              if (action.type === "diff.open") {
                const left = await resolveSourceTarget(request.workspacePath, action.leftPath);
                const right = await resolveSourceTarget(request.workspacePath, action.rightPath);
                return {
                  ...action,
                  leftPath: relative(left.workspace, left.target).split(sep).join("/"),
                  rightPath: relative(right.workspace, right.target).split(sep).join("/"),
                };
              }
              if (action.type === "diagnostics.list" && action.path) {
                const target = await resolveSourceTarget(request.workspacePath, action.path);
                return {
                  ...action,
                  path: relative(target.workspace, target.target).split(sep).join("/"),
                };
              }
              return action;
            });
            const result = yield* tryServer("performEditorAction", (signal) =>
              runtime.performEditorAction(request.workspacePath, normalized, signal),
            );
            return { requestId: request.requestId, result };
          },
        ),
        updateAnnotations: Effect.fn("VsCodeServer.updateAnnotations")(
          function* (connectionId, request) {
            yield* requireViewer(connectionId, request.workspacePath);
            const normalized = yield* tryServer("updateAnnotations", async () => {
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
            yield* tryServer("updateAnnotations", (signal) =>
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
          },
        ),
        runProjectScript: Effect.fn("VsCodeServer.runProjectScript")(
          function* (workingDirectory, source, input) {
            yield* requireAllowed(workingDirectory);
            return yield* tryServer("runProjectScript", async (signal) => {
              signal.throwIfAborted();
              if (!(await runtime.isVisible(workingDirectory)))
                return { status: "mode-required" as const };
              const value = await runtime.runScript(workingDirectory, source, input, signal);
              signal.throwIfAborted();
              return { status: "completed" as const, value };
            });
          },
        ),
      });
    }),
  );
