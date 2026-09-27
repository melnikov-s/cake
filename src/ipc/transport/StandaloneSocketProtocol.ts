import { Effect, Layer, Option, Queue, Result } from "effect";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { AttachmentUploads } from "../../services/filesystem/AttachmentUploads";
import * as workingDirectoryTerminals from "../../domain/terminals/workingDirectoryTerminals";
import { RpcServer } from "effect/unstable/rpc";
import { ClientConnections } from "../../services/clients/ClientConnections";
import { ClientWorkspaces } from "../../services/clients/ClientWorkspaces";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { RewordingRequests } from "../../services/projects/RewordingRequests";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import {
  correlationIdHeader,
  rendererConnectionHeader,
} from "../protocol/RendererConnectionMiddleware";
import { parseRendererRpcMessage } from "./ElectronRpcTransport";

/** Effect's endpoint-local socket IDs are mapped to the shared process client authority. */
export const StandaloneSocketProtocolLive = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const backing = yield* RpcServer.makeProtocolSocketServer;
    const workspaces = yield* ClientWorkspaces;
    const access = yield* ProjectAccess;
    const rewording = yield* RewordingRequests;
    const requests = yield* RendererRequestCoordinator;
    const disconnects = yield* Queue.unbounded<number>();
    const connections = yield* ClientConnections;
    const vscode = yield* Effect.serviceOption(VsCodeServer);
    const uploads = yield* Effect.serviceOption(AttachmentUploads);
    const active = new Map<number, number>();
    const release = Effect.fn("StandaloneSocketProtocol.release")(function* (socketId: number) {
      const connectionId = active.get(socketId);
      if (connectionId === undefined) return;
      active.delete(socketId);
      connections.release(connectionId);
      workspaces.releaseConnection(connectionId);
      yield* Effect.all(
        [
          workingDirectoryTerminals
            .closeOwner(connectionId)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Terminal disconnect cleanup failed", error),
              ),
            ),
          access.clearOwner(connectionId),
          Option.isSome(uploads) ? uploads.value.releaseConnection(connectionId) : Effect.void,
          rewording.disposeOwner(connectionId),
          requests.releaseConnection(connectionId),
          Option.isSome(vscode) ? vscode.value.releaseConnection(connectionId) : Effect.void,
        ],
        { concurrency: "unbounded", discard: true },
      );
    }, Effect.uninterruptible);

    // This finalizer also covers listener shutdown, when the queue consumer itself is interrupted.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...active.keys()], release, { discard: true }),
    );
    yield* Effect.forever(
      Queue.take(backing.disconnects).pipe(
        Effect.tap(release),
        Effect.flatMap((id) => Queue.offer(disconnects, id)),
      ),
    ).pipe(Effect.forkScoped);

    return RpcServer.Protocol.of({
      ...backing,
      disconnects,
      run: (writeRequest) =>
        backing.run((socketId, input) => {
          const decoded = parseRendererRpcMessage(input);
          if (Result.isFailure(decoded)) return Effect.void;
          const message = decoded.success;
          let connectionId = active.get(socketId);
          if (connectionId === undefined) {
            connectionId = connections.socket();
            active.set(socketId, connectionId);
          }
          if (message._tag !== "Request") return writeRequest(socketId, message);
          // Filter case-insensitively BEFORE Effect Headers normalizes header names. Neither the
          // upgrade request nor RPC payload may impersonate another connection/correlation.
          const headers = message.headers.filter(([name]) => {
            const lower = name.toLowerCase();
            return lower !== rendererConnectionHeader && lower !== correlationIdHeader;
          });
          return writeRequest(socketId, {
            ...message,
            headers: [
              ...headers,
              [rendererConnectionHeader, String(connectionId)],
              [correlationIdHeader, `${connectionId}:${String(message.id)}`],
            ],
          });
        }),
    });
  }),
);
