import { Effect, Layer, Semaphore } from "effect";
import { Browser } from "./Browser";
import { Electron } from "../electron/Electron";
import { openNativePreviewTunnel } from "./NativePreviewTunnel";
import { NativePreviewError } from "../../contracts/browser/native-preview-tunnels-errors";
import { NativePreviewTunnels } from "./NativePreviewTunnels";

/** Native-only registration: trusted renderer calls this after backend lease admission.
 * No auxiliary socket is ever used as a backend RPC client or session control identity. */
export const makeNativePreviewTunnelsLive = (
  backendRpcUrl: string,
  openTunnel: typeof openNativePreviewTunnel = openNativePreviewTunnel,
) =>
  Layer.effect(
    NativePreviewTunnels,
    Effect.gen(function* () {
      const electron = yield* Electron;
      const browser = yield* Browser;
      const lock = yield* Semaphore.make(1);
      const active = new Map<
        number,
        { sessionId: string; endpoint: string; secret: string; close: () => void }
      >();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const tunnel of active.values()) tunnel.close();
          active.clear();
        }),
      );
      return NativePreviewTunnels.of({
        open: Effect.fn("NativePreviewTunnels.open")((connectionId, sessionId, lease) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const sender = yield* Effect.try({
                try: () => electron.requireRendererConnection(connectionId),
                catch: () => new NativePreviewError({ message: "Desktop window is unavailable" }),
              });
              yield* browser
                .state(connectionId, sessionId)
                .pipe(
                  Effect.mapError((error) => new NativePreviewError({ message: error.message })),
                );
              const previous = active.get(connectionId);
              if (previous?.sessionId === sessionId && previous.secret === lease.secret)
                return previous.endpoint;
              previous?.close();
              active.delete(connectionId);
              let registered = false;
              // Acquisition is masked by acquireRelease. If cancellation wins before transfer,
              // the operation scope closes the listener instead of dropping its Promise result.
              const tunnel = yield* Effect.acquireRelease(
                Effect.tryPromise({
                  try: () => openTunnel(backendRpcUrl, lease),
                  catch: () => new NativePreviewError({ message: "Cannot open desktop preview" }),
                }),
                (tunnel) =>
                  Effect.sync(() => {
                    if (!registered) tunnel.close();
                  }),
              );
              if (sender.isDestroyed())
                return yield* new NativePreviewError({ message: "Desktop window is unavailable" });
              const close = () => {
                sender.off("destroyed", close);
                tunnel.close();
                if (active.get(connectionId)?.endpoint === tunnel.endpoint)
                  active.delete(connectionId);
              };
              sender.once("destroyed", close);
              active.set(connectionId, {
                sessionId,
                endpoint: tunnel.endpoint,
                secret: lease.secret,
                close,
              });
              registered = true;
              return tunnel.endpoint;
            }).pipe(Effect.scoped),
          ),
        ),
      });
    }),
  );
