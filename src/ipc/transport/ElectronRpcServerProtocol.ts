import { Effect, Layer, Option, Queue, Result } from "effect";
import {
  ipcMain,
  webContents,
  type IpcMainEvent,
  type WebContents,
  type WebContentsDidStartNavigationEventParams,
} from "electron";
import { ClientConnections } from "../../services/clients/ClientConnections";
import { RpcServer, RpcSerialization } from "effect/rpc";
import type { FromClientEncoded } from "effect/rpc/RpcMessage";
import {
  RendererDocumentLifetime,
  correlationIdHeader,
  rendererConnectionHeader,
} from "../protocol/RendererConnectionMiddleware";
import { rpcRequestChannel, rpcResponseChannel } from "./ElectronRpcChannels";
import { parseRendererRpcMessage } from "./ElectronRpcTransport";

interface IncomingMessage {
  readonly connectionId: number;
  readonly message: FromClientEncoded;
  readonly documentLifetime?: AbortSignal;
}

function withTrustedMetadata(connectionId: number, message: FromClientEncoded): FromClientEncoded {
  if (message._tag !== "Request") return message;
  const headers = message.headers.filter(
    ([name]) =>
      name.toLowerCase() !== rendererConnectionHeader && name.toLowerCase() !== correlationIdHeader,
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
    const connections = yield* ClientConnections;
    const incoming = yield* Queue.unbounded<IncomingMessage>();
    const disconnects = yield* Queue.unbounded<number>();
    const connectionIds = new Set<number>();
    const watchedConnections = new Map<
      number,
      { capture(event: IpcMainEvent): AbortSignal; dispose(): void }
    >();

    // A WebContents and its RPC identity survive renderer loss and reload. Only the
    // bridge's document lifetime ends; leave the connection and other routes alone.
    function watchDocument(connectionId: number, contents: WebContents) {
      let document = new AbortController();
      const revoke = () => document.abort();
      const navigation = (event: Electron.Event<WebContentsDidStartNavigationEventParams>) => {
        if (event.isMainFrame && !event.isSameDocument) revoke();
      };
      const committed = () => {
        revoke();
        document = new AbortController();
      };
      const destroyed = () => {
        dispose();
        connectionIds.delete(connectionId);
        watchedConnections.delete(connectionId);
        connections.release(connectionId);
        Queue.offerUnsafe(disconnects, connectionId);
      };
      const dispose = () => {
        revoke();
        contents.removeListener("render-process-gone", revoke);
        contents.removeListener("did-start-navigation", navigation);
        contents.removeListener("did-navigate", committed);
        contents.removeListener("destroyed", destroyed);
      };
      contents.on("render-process-gone", revoke);
      contents.on("did-start-navigation", navigation);
      contents.on("did-navigate", committed);
      contents.once("destroyed", destroyed);
      return {
        capture: (event: IpcMainEvent) => {
          const frame = event.senderFrame;
          if (contents.isCrashed() || !frame || frame.detached || frame !== contents.mainFrame)
            return AbortSignal.abort();
          return AbortSignal.any([document.signal, connections.signal(connectionId)]);
        },
        dispose,
      };
    }

    const onRequest = (event: IpcMainEvent, input: unknown) => {
      const decoded = parseRendererRpcMessage(input);
      if (Result.isFailure(decoded)) {
        console.error("[cake.rpc] Rejected malformed renderer transport message", decoded.failure);
        return;
      }
      const connectionId = connections.desktop(event.sender.id);
      const message = decoded.success;
      connectionIds.add(connectionId);
      let watched = watchedConnections.get(connectionId);
      if (!watched) {
        watched = watchDocument(connectionId, event.sender);
        watchedConnections.set(connectionId, watched);
      }
      Queue.offerUnsafe(incoming, {
        connectionId,
        message: withTrustedMetadata(connectionId, message),
        ...(message._tag === "Request" &&
        (message.tag === "sessionChats.prompt" ||
          message.tag === "projectSessions.start" ||
          message.tag === "cakeChats.start" ||
          message.tag === "savedDrafts.activate" ||
          message.tag === "dictation.transcribe")
          ? { documentLifetime: watched.capture(event) }
          : null),
      });
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => ipcMain.on(rpcRequestChannel, onRequest)),
      () =>
        Effect.sync(() => {
          ipcMain.removeListener(rpcRequestChannel, onRequest);
          for (const watched of watchedConnections.values()) watched.dispose();
          watchedConnections.clear();
        }),
    );

    return RpcServer.Protocol.of({
      run: (writeRequest) =>
        Effect.forever(
          Queue.take(incoming).pipe(
            Effect.flatMap(({ connectionId, message, documentLifetime }) => {
              const write = writeRequest(connectionId, message);
              return documentLifetime
                ? write.pipe(Effect.provideService(RendererDocumentLifetime, documentLifetime))
                : write;
            }),
          ),
        ),
      disconnects,
      send: (connectionId, response) =>
        Effect.sync(() => {
          const nativeId = connections.nativeId(connectionId);
          const target = nativeId === undefined ? undefined : webContents.fromId(nativeId);
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
      codecFor: RpcSerialization.json.codecFor,
    });
  }),
);
