import { Context, Effect, Layer, Option, Schema } from "effect";
import { RpcMiddleware } from "effect/unstable/rpc";
import { Headers } from "effect/unstable/http";

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

export const RendererConnectionMiddlewareLive = Layer.succeed(
  RendererConnectionMiddleware,
  rendererConnectionMiddleware,
);
