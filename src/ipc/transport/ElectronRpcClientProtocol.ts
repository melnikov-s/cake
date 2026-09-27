import { Effect, Layer, Queue, Result } from "effect";
import { RpcClient, RpcClientError } from "effect/unstable/rpc";
import { parseMainRpcMessage, type ElectronRpcTransport } from "./ElectronRpcTransport";

export const makeElectronRpcClientProtocol = (transport: ElectronRpcTransport) =>
  Layer.effect(
    RpcClient.Protocol,
    RpcClient.Protocol.make((writeResponse, clientIds) =>
      Effect.gen(function* () {
        const incoming = yield* Queue.unbounded<Parameters<typeof writeResponse>[1]>();
        const recipients = new Map<string, number>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            transport.subscribe((message) => {
              const decoded = parseMainRpcMessage(message);
              if (Result.isSuccess(decoded)) Queue.offerUnsafe(incoming, decoded.success);
              else
                console.error(
                  "[cake.rpc] Rejected malformed main transport message",
                  decoded.failure,
                );
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(incoming).pipe(
              Effect.flatMap((message) => {
                if (message._tag === "Exit" || message._tag === "Chunk") {
                  const id = String(message.requestId);
                  const clientId = recipients.get(id);
                  if (message._tag === "Exit") recipients.delete(id);
                  return clientId === undefined ? Effect.void : writeResponse(clientId, message);
                }
                // A connection-level defect completes every pending RPC. Retire the routing
                // entries too, including requests for which no individual Exit will arrive.
                if (message._tag === "Defect") recipients.clear();
                return Effect.forEach(clientIds, (clientId) => writeResponse(clientId, message), {
                  discard: true,
                });
              }),
            ),
          ),
        );

        return {
          send: (clientId, request) =>
            Effect.try({
              try: () => {
                if (request._tag === "Request" && !request.isNotification)
                  recipients.set(String(request.id), clientId);
                if (request._tag === "Interrupt") recipients.delete(String(request.requestId));
                transport.send(request);
              },
              catch: (cause) => {
                if (request._tag === "Request") recipients.delete(String(request.id));
                return new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: "Electron RPC transport send failed",
                    cause,
                  }),
                });
              },
            }),
          supportsAck: true,
          supportsTransferables: false,
        };
      }),
    ),
  );
