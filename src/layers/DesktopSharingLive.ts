import { Effect, Layer, Schema, Scope, Semaphore, SubscriptionRef } from "effect";
import type { FileSystem, Path } from "effect";
import {
  DesktopSharingError,
  DesktopSharingInput,
  type DesktopSharingPreferences,
  type DesktopSharingState,
} from "../contracts/desktop/desktop-sharing-data";
import { openNetworkListener, type NetworkListenerOptions } from "../server/NetworkListener";
import { DesktopSharing } from "../services/electron/DesktopSharing";
import {
  loadDesktopSharingPreferences,
  saveDesktopSharingPreferences,
} from "../services/storage/desktop-sharing-preferences";

type Backend = Exclude<Effect.Services<ReturnType<typeof openNetworkListener>>, Scope.Scope>;
/** Captures the acquired backend Context once; toggles own only listener resources.
 * Mutations serialize and, once started, finish independently of an IPC request cancellation.
 * The process Scope (not a renderer/request Scope) owns every attachment and accepted turn.
 */
export const makeDesktopSharingLive = (
  configuration: Parameters<typeof openNetworkListener>[1],
  browserAssetsDirectory: string,
  userDataDirectory: string,
) =>
  Layer.effect(
    DesktopSharing,
    Effect.gen(function* () {
      const backend = yield* Effect.context<Backend>();
      const lifetime = yield* Effect.scope;
      const storage = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const lock = yield* Semaphore.make(1);
      let preferences = yield* loadDesktopSharingPreferences(userDataDirectory);
      let state: DesktopSharingState = { status: "disabled", ...preferences, preferences };
      const updates = yield* SubscriptionRef.make(state);
      let listener: Effect.Success<ReturnType<typeof openNetworkListener>> | undefined;
      const publish = (next: DesktopSharingState) =>
        Effect.gen(function* () {
          state = next;
          yield* SubscriptionRef.set(updates, next);
        });
      const persist = Effect.fn("DesktopSharing.persistPreferences")(function* (
        input: DesktopSharingPreferences,
      ) {
        preferences = yield* saveDesktopSharingPreferences(userDataDirectory, input).pipe(
          Effect.provide(storage),
        );
      });
      const updatePreferences = Effect.fn("DesktopSharing.updatePreferences")(
        function* (input: DesktopSharingPreferences) {
          if (listener)
            return yield* new DesktopSharingError({
              message: "Disable browser sharing before changing connection preferences.",
            });
          yield* persist(input);
          yield* publish({ status: "disabled", ...preferences, preferences });
          return state;
        },
        (effect) => Effect.uninterruptible(lock.withPermits(1)(effect)),
      );
      const configure = Effect.fn("DesktopSharing.configure")(
        function* (input: DesktopSharingInput) {
          const settings = yield* Schema.decodeUnknownEffect(DesktopSharingInput)(input).pipe(
            Effect.mapError((error) => new DesktopSharingError({ message: error.message })),
          );
          if (settings.enabled && listener) return state;
          if (!settings.enabled) {
            yield* publish({ ...state, preferences, status: "stopping" });
            if (listener) yield* listener.close();
            listener = undefined;
            yield* publish({ status: "disabled", ...preferences, preferences });
            // A disk failure must never prevent switching off an exposed listener.
            yield* persist(settings);
            yield* publish({ status: "disabled", ...preferences, preferences });
            return state;
          }
          yield* persist(settings);
          yield* publish({ status: "starting", ...preferences, preferences });
          const options: NetworkListenerOptions = {
            bind: settings.bind,
            port: settings.port,
            browserAssetsDirectory,
          };
          if (settings.publicOrigin)
            Object.assign(options, {
              allowedHosts: [new URL(settings.publicOrigin).host],
              allowedOrigins: [settings.publicOrigin],
            });
          const opened = yield* openNetworkListener(options, configuration).pipe(
            Effect.provide(backend),
            Scope.provide(lifetime),
            Effect.mapError(
              (error) =>
                new DesktopSharingError({
                  message: `${error.message} Check the bind address and whether the port is in use. If browser assets are missing, build them with pnpm build:browser.`,
                }),
            ),
            Effect.tapError((error) =>
              publish({ ...state, status: "failed", error: error.message }),
            ),
          );
          listener = opened;
          if (opened.address._tag !== "TcpAddress")
            return yield* Effect.die("Expected TCP listener");
          const serving: DesktopSharingState = {
            status: "serving",
            preferences,
            bind: settings.bind,
            port: opened.address.port,
            editorPort: opened.editorPort,
            url: settings.publicOrigin
              ? `${settings.publicOrigin}/`
              : `http://${settings.bind}:${opened.address.port}/`,
          };
          if (settings.publicOrigin)
            Object.assign(serving, { publicOrigin: settings.publicOrigin });
          yield* publish(serving);
          return state;
        },
        (effect) => Effect.uninterruptible(lock.withPermits(1)(effect)),
      );
      return DesktopSharing.of({
        configure,
        updatePreferences,
        changes: () => SubscriptionRef.changes(updates),
        keepsProcessAlive: () =>
          state.status === "starting" || state.status === "serving" || state.status === "stopping",
      });
    }),
  );
