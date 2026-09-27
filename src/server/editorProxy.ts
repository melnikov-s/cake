import { NodeSocket } from "@effect/platform-node-shared";
import { Effect, Option } from "effect";
import { Socket } from "effect/unstable/socket";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { VsCodeServer } from "../services/vscode/VsCodeServer";
import type { VsCodeLease } from "../services/vscode/VsCodeServerRuntime";

/** A bearer capability issued only to the owning desktop. The owner component is
 * checked as well as the unguessable lease; neither is an arbitrary upstream URL. */
export const editorLeasePath = (lease: Pick<VsCodeLease, "id" | "connectionId">) =>
  `/editor/${lease.connectionId}/${lease.id}/`;

export interface EditorProxyTarget {
  readonly lease: VsCodeLease;
  readonly prefix: string;
  readonly path: string;
}

/** Keep the exposed surface to the workbench, not code-server's administration,
 * port proxy, or Cake's companion bridge. Decode once and reject ambiguous paths. */
export function editorProxyTarget(
  server: VsCodeServer["Service"],
  raw: string,
  upgrade = false,
): EditorProxyTarget | undefined {
  const match = /^\/editor\/([1-9][0-9]*)\/([a-f0-9]{64})(\/[^#]*)$/.exec(raw);
  if (!match) return;
  const lease = server.leaseFor(Number(match[1]));
  if (
    !lease ||
    lease.id !== match[2] ||
    lease.revocation.signal.aborted ||
    lease.flavor !== "codeserver"
  )
    return;
  const path = match[3];
  if (!path) return;
  const pathname = path.split("?", 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return;
  }
  if (
    decoded.includes("%") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "." || part === "..") ||
    decoded.includes("//")
  )
    return;
  const route = decoded.replace(/^\/(?:stable|insider)-[a-f0-9]{40}(?=\/|$)/, "") || "/";
  if (upgrade && route !== "/") return;
  const query = new URL(path, lease.url).searchParams;
  const folders = query.getAll("folder");
  if (
    query.has("workspace") ||
    folders.length > 1 ||
    (folders.length === 1 && folders[0] !== lease.workspacePath)
  )
    return;
  if (
    !/^(?:\/$|\/static\/|\/_static\/|\/vscode-remote-resource$|\/web-extension-resource\/|\/callback$|\/manifest\.json$|\/mint-key$)/.test(
      route,
    )
  )
    return;
  return { lease, prefix: editorLeasePath(lease), path };
}

const forwardedHeaders = [
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
] as const;
const responseHeaders = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "content-security-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
] as const;

/** Node streams provide backpressure. Each request dies with its lease, listener,
 * or downstream connection. Never forward cookies, auth, Host or forwarding headers. */
export function proxyEditorHttp(
  request: IncomingMessage,
  response: ServerResponse,
  target: EditorProxyTarget,
  listenerSignal: AbortSignal,
) {
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    !(request.method === "POST" && target.path === "/mint-key")
  ) {
    response.writeHead(405);
    response.end();
    return;
  }
  const headers: Record<string, string | string[]> = {};
  for (const name of forwardedHeaders) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const upstreamUrl = new URL(target.path, target.lease.url);
  const signal = AbortSignal.any([listenerSignal, target.lease.revocation.signal]);
  const upstream = httpRequest(
    upstreamUrl,
    { method: request.method, headers, signal },
    (source) => {
      for (const name of responseHeaders) {
        const value = source.headers[name];
        if (value !== undefined) response.setHeader(name, value);
      }
      // Service workers must never escape their individual leased workbench.
      response.setHeader("Service-Worker-Allowed", target.prefix);
      response.setHeader("Referrer-Policy", "no-referrer");
      if (source.headers.location) {
        const location = new URL(source.headers.location, upstreamUrl);
        if (location.origin !== upstreamUrl.origin) {
          source.destroy();
          response.writeHead(502);
          response.end();
          return;
        }
        const rewritten = target.prefix.slice(0, -1) + location.pathname + location.search;
        // A redirect is subject to the same route policy on its next request.
        response.setHeader("Location", rewritten);
      }
      response.writeHead(source.statusCode ?? 502);
      source.on("error", () => response.destroy());
      source.pipe(response);
    },
  );
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("Editor upstream timeout")));
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(signal.aborted ? 410 : 502);
    response.end();
  });
  response.once("close", () => upstream.destroy());
  request.once("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

/** The listener's installed ws implementation owns upgrades. Bridge messages
 * without touching the RPC protocol, retaining text/binary flags and bounding
 * in-flight writes; pause reads until the peer's send callback drains. */
export const proxyEditorSocket = Effect.fn("EditorProxy.socket")(function* (
  target: EditorProxyTarget,
) {
  const current = yield* Effect.serviceOption(Socket.WebSocket);
  if (Option.isNone(current) || !(current.value instanceof NodeSocket.NodeWS.WebSocket))
    return yield* Effect.die("Expected a Node editor WebSocket");
  const downstream = current.value;
  yield* Effect.callback<void>((resume) => {
    const url = new URL(target.path, target.lease.url);
    url.protocol = "ws:";
    const upstream = new NodeSocket.NodeWS.WebSocket(url, {
      origin: new URL(target.lease.url).origin,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 10_000,
    });
    const close = () => {
      upstream.terminate();
      downstream.terminate();
      resume(Effect.void);
    };
    const signal = target.lease.revocation.signal;
    signal.addEventListener("abort", close, { once: true });
    downstream.pause();
    upstream.once("open", () => downstream.resume());
    for (const [from, to] of [
      [downstream, upstream],
      [upstream, downstream],
    ] as const) {
      let pending = 0;
      from.on("message", (data, binary) => {
        const size = Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data.byteLength;
        pending += size;
        if (pending > 16 * 1024 * 1024 || to.readyState !== NodeSocket.NodeWS.WebSocket.OPEN) {
          close();
          return;
        }
        from.pause();
        to.send(data, { binary }, (error) => {
          pending -= size;
          if (error) close();
          else if (pending === 0) from.resume();
        });
      });
      from.once("error", close);
      from.once("close", close);
    }
    if (signal.aborted) close();
    return Effect.sync(() => {
      signal.removeEventListener("abort", close);
      upstream.terminate();
      downstream.terminate();
    });
  });
});
