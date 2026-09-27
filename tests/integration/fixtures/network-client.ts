import { NodeSocket } from "@effect/platform-node-shared";
import { Effect, Exit, Layer, Queue, Schedule, Scope } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { BackendRpc } from "../../../src/ipc/protocol/BackendRpc";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import { parseMainRpcMessage } from "../../../src/ipc/transport/ElectronRpcTransport";
import { Result } from "effect";

export const connectClient = Effect.fn("NetworkTest.connect")(function* (
  url: string,
  origin?: string,
) {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) }),
  ).pipe(
    Layer.provide(
      Layer.merge(
        Socket.layerWebSocket(url).pipe(
          Layer.provide(
            origin
              ? Layer.succeed(
                  Socket.WebSocketConstructor,
                  (address, protocols) =>
                    // ws implements Effect's required browser WebSocket API; its Node
                    // overload types differ from lib.dom. This is an external adapter
                    // boundary, not an unchecked RPC/data conversion.
                    new NodeSocket.NodeWS.WebSocket(address, protocols, {
                      origin,
                    }) as unknown as globalThis.WebSocket,
                )
              : Socket.layerWebSocketConstructorGlobal,
          ),
        ),
        RpcSerialization.layerJson,
      ),
    ),
  );
  const context = yield* Layer.buildWithScope(protocol, scope);
  const client = yield* RpcClient.make(BackendRpc).pipe(
    Effect.provideContext(context),
    Scope.provide(scope),
  );
  // A real successful request is the connection/readiness barrier.
  yield* client["models.list"]();
  return { client, close: () => Scope.close(scope, Exit.void) };
});

/** Raw ws only for adversarial frames/headers which the typed client correctly normalizes. */
export const rawClient = Effect.fn("NetworkTest.rawClient")(function* (
  url: string,
  options?: NodeSocket.NodeWS.ClientOptions,
) {
  const messages = yield* Queue.unbounded<FromServerEncoded>();
  const closed = yield* Queue.unbounded<number>();
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSocket.NodeWS.WebSocket(url, options)),
    (socket) => Effect.sync(() => socket.terminate()),
  );
  ws.on("close", (code) => Queue.offerUnsafe(closed, code));
  ws.on("message", (data) => {
    const message = parseMainRpcMessage(JSON.parse(data.toString()));
    if (Result.isSuccess(message)) Queue.offerUnsafe(messages, message.success);
  });
  yield* Effect.callback<void, Error>((resume) => {
    ws.once("open", () => resume(Effect.void));
    ws.once("error", (error) => resume(Effect.fail(error)));
  });
  return { ws, messages, closed };
});
