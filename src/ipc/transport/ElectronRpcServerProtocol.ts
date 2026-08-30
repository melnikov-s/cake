import { Effect, Layer, Option, Queue } from "effect";
import { ipcMain, webContents, type IpcMainEvent } from "electron";
import { RpcServer } from "effect/unstable/rpc";
import type { FromClientEncoded } from "effect/unstable/rpc/RpcMessage";
import {
  correlationIdHeader,
  rendererConnectionHeader,
} from "../protocol/RendererConnectionMiddleware";
import { rpcRequestChannel, rpcResponseChannel } from "./ElectronRpcChannels";
import { parseRendererRpcMessage } from "./ElectronRpcTransport";

interface IncomingMessage {
  readonly connectionId: number;
  readonly message: FromClientEncoded;
}

function withTrustedMetadata(connectionId: number, message: FromClientEncoded): FromClientEncoded {
  if (message._tag !== "Request") return message;
  const headers = message.headers.filter(
    ([name]) => name !== rendererConnectionHeader && name !== correlationIdHeader,
  );
  return {
    ...message,
    headers: [
      ...headers,
      [rendererConnectionHeader, String(connectionId)],
      [correlationIdHeader, `${connectionId}:${String(message.id)}`],
    ],
  };
}

export const ElectronRpcServerProtocolLive = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<IncomingMessage>();
    const disconnects = yield* Queue.unbounded<number>();
    const connectionIds = new Set<number>();
    const watchedConnections = new Set<number>();

    const onRequest = (event: IpcMainEvent, input: unknown) => {
      const connectionId = event.sender.id;
      let message: FromClientEncoded;
      try {
        message = parseRendererRpcMessage(input);
      } catch (error) {
        console.error("[cake.rpc] Rejected malformed renderer transport message", error);
        return;
      }
      connectionIds.add(connectionId);
      if (!watchedConnections.has(connectionId)) {
        watchedConnections.add(connectionId);
        event.sender.once("destroyed", () => {
          connectionIds.delete(connectionId);
          watchedConnections.delete(connectionId);
          Queue.offerUnsafe(disconnects, connectionId);
        });
      }
      Queue.offerUnsafe(incoming, {
        connectionId,
        message: withTrustedMetadata(connectionId, message),
      });
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on(rpcRequestChannel, onRequest)),
      () => Effect.sync(() => ipcMain.removeListener(rpcRequestChannel, onRequest)),
    );

    return RpcServer.Protocol.of({
      run: (writeRequest) =>
        Effect.forever(
          Queue.take(incoming).pipe(
            Effect.flatMap(({ connectionId, message }) => writeRequest(connectionId, message)),
          ),
        ),
      disconnects,
      send: (connectionId, response) =>
        Effect.sync(() => {
          const target = webContents.fromId(connectionId);
          if (target && !target.isDestroyed()) target.send(rpcResponseChannel, response);
        }),
      end: (connectionId) =>
        Effect.sync(() => {
          connectionIds.delete(connectionId);
        }),
      clientIds: Effect.sync(() => new Set(connectionIds)),
      initialMessage: Effect.succeed(Option.none()),
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
      supportsNotifications: false,
    });
  }),
);
