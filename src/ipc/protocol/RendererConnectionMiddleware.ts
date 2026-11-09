import { Context, Effect, Layer, Option, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { Headers } from "effect/http";
import { BackendRecovery } from "../../services/startup/BackendRecovery";

export const rendererConnectionHeader = "x-cake-renderer-connection";
export const correlationIdHeader = "x-cake-correlation-id";

export interface RendererConnectionInfo {
  readonly connectionId: number;
  readonly correlationId: string;
}

export class RendererConnection extends Context.Service<
  RendererConnection,
  RendererConnectionInfo
>()("cake/ipc/RendererConnection") {}

export class RendererConnectionMiddleware extends RpcMiddleware.Service<
  RendererConnectionMiddleware,
  { provides: RendererConnection }
>()("cake/ipc/RendererConnectionMiddleware", {
  error: Schema.Never,
}) {}

const rendererConnectionMiddleware: RendererConnectionMiddleware["Service"] = (effect, options) => {
  const connectionId = Number(
    Option.getOrUndefined(Headers.get(options.headers, rendererConnectionHeader)),
  );
  const correlationId = Option.getOrElse(Headers.get(options.headers, correlationIdHeader), () =>
    String(options.requestId),
  );
  if (!Number.isSafeInteger(connectionId) || connectionId < 1)
    return Effect.die("RPC request is missing its trusted renderer connection identity");
  return effect.pipe(
    Effect.provideService(RendererConnection, { connectionId, correlationId }),
    Effect.annotateLogs({
      "cake.rpc.connection_id": connectionId,
      "cake.rpc.correlation_id": correlationId,
      "cake.rpc.method": options.rpc._tag,
    }),
    Effect.annotateSpans({
      "cake.rpc.connection_id": connectionId,
      "cake.rpc.correlation_id": correlationId,
    }),
  );
};

export const RendererConnectionMiddlewareLive = Layer.effect(
  RendererConnectionMiddleware,
  Effect.gen(function* () {
    // Remote native hosts have no backend. Their native RPCs remain independent.
    // Only host discovery/build handshake, native snapshot hydration/persistence,
    // legacy draft import and the flush stream bypass reconciliation locally.
    // These cannot execute a session. Draft activation stays gated.
    const recovery = yield* Effect.serviceOption(BackendRecovery);
    return RendererConnectionMiddleware.of((effect, options) =>
      rendererConnectionMiddleware(
        Option.isSome(recovery) &&
          ![
            "desktopHost.current",
            "backendConnection.connect",
            "savedDrafts.create",
            "windowState.load",
            "windowState.save",
            "windowState.respondFlush",
            "electron.observeSurfaceEvents",
          ].includes(options.rpc._tag)
          ? Effect.andThen(recovery.value.awaitReady(), effect)
          : effect,
        options,
      ),
    );
  }),
);
