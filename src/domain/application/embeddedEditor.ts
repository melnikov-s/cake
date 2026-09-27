import { Effect, Option } from "effect";
import { DesktopHost } from "../../services/electron/DesktopHost";
import { VsCodeViews } from "../../services/vscode/VsCodeViews";
import { setVscodeServerPath } from "./application";
import { VsCodeServer, VsCodeServerError } from "../../services/vscode/VsCodeServer";
import type { AcquireEditor, EditorEndpoint } from "../../ipc/protocol/VsCodeRpc";
import { EditorBrowserPort } from "../../server/EditorBrowserPort";

/** Backend issues a presentation capability. Internal addresses and server tokens
 * never cross RPC, even when the desktop and backend share an Electron host. */
export const acquire = Effect.fn("EmbeddedEditor.acquire")(function* (
  connectionId: number,
  request: typeof AcquireEditor.Type,
) {
  const server = yield* VsCodeServer;
  const port = yield* Effect.serviceOption(EditorBrowserPort);
  const lease = yield* server.acquire(connectionId, request);
  const endpoint = `/editor/${connectionId}/${lease.id}/`;
  if (Option.isSome(port) && port.value.port !== undefined) {
    if (port.value.publicOrigin)
      return {
        id: lease.id,
        endpoint,
        editorPort: port.value.port,
        editorOrigin: port.value.publicOrigin,
      };
    return { id: lease.id, endpoint, editorPort: port.value.port };
  }
  return { id: lease.id, endpoint };
});

/** Native presentation accepts only this host's editor endpoint. The remote host
 * deliberately has no VsCodeServer service and never resolves server paths. */
export const present = Effect.fn("EmbeddedEditor.present")(function* (
  connectionId: number,
  request: typeof EditorEndpoint.Type,
) {
  const host = (yield* DesktopHost).current();
  const backend = yield* Effect.serviceOption(VsCodeServer);
  const localLease =
    host.kind === "local" && Option.isSome(backend)
      ? backend.value.leaseFor(connectionId)
      : undefined;
  const endpoint = host.kind === "local" ? localLease?.url : request.url;
  const allowed = (() => {
    try {
      if (host.kind === "local") {
        return (
          localLease !== undefined &&
          request.url === `/editor/${connectionId}/${localLease.id}/` &&
          localLease.presentedWorkspacePath === request.workspacePath
        );
      }
      const url = new URL(request.url);
      const configured = new URL(host.url);
      configured.protocol = configured.protocol === "wss:" ? "https:" : "http:";
      return (
        url.origin === configured.origin &&
        /^\/editor\/[1-9][0-9]*\/[a-f0-9]{64}\/$/.test(url.pathname) &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  })();
  if (!allowed || !endpoint)
    return yield* new VsCodeServerError({
      operation: "openView",
      message: "Invalid editor endpoint for this desktop host",
    });
  yield* (yield* VsCodeViews).open(connectionId, { ...request, url: endpoint });
});

/** Persists the selected binary and then refreshes the concrete server projection. */
export const setServerPath = Effect.fn("EmbeddedEditor.setServerPath")(function* (
  path: string | undefined,
) {
  const server = yield* VsCodeServer;
  const state = yield* setVscodeServerPath(path).pipe(
    Effect.mapError(
      (error) =>
        new VsCodeServerError({
          operation: "setServerPath",
          message: error instanceof Error ? error.message : String(error),
        }),
    ),
  );
  yield* server.refreshStatus();
  return state;
});
