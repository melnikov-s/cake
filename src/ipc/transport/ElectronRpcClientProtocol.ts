import { Effect, Layer, Queue } from "effect";
import { RpcClient, RpcClientError } from "effect/unstable/rpc";
import { parseMainRpcMessage, type ElectronRpcTransport } from "./ElectronRpcTransport";

export const makeElectronRpcClientProtocol = (transport: ElectronRpcTransport) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.Protocol.make((writeResponse) =>
      Effect.gen(function* () {
        const incoming = yield* Queue.unbounded<Parameters<typeof writeResponse>[1]>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            transport.subscribe((message) => {
              Queue.offerUnsafe(incoming, parseMainRpcMessage(message));
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(incoming).pipe(Effect.flatMap((message) => writeResponse(0, message))),
          ),
        );

        return {
          send: (_clientId, request) =>
            Effect.try({
              try: () => transport.send(request),
              catch: (cause) =>
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: "Electron RPC transport send failed",
                    cause,
                  }),
                }),
            }),
          supportsAck: true,
          supportsTransferables: false,
        };
      }),
    ),
  );
