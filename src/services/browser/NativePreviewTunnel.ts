import { NodeSocket } from "@effect/platform-node-shared";
import { randomBytes } from "node:crypto";
import { Predicate } from "effect";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

const WS = NodeSocket.NodeWS;
const MAX_BODY = 16 * 1024 * 1024;
const MAX_FRAME = 1024 * 1024;

/** Device-local, isolated origin. Only this native adapter knows the bridge secret;
 * Chromium runs untrusted dev JS on a unique *.localhost origin, never Cake's origin.
 * The upstream is always the already-configured Cake endpoint, over its original TLS.
 */
export async function openNativePreviewTunnel(
  backendRpcUrl: string,
  lease: { endpoint: string; secret: string },
) {
  const backend = new URL(backendRpcUrl);
  if (
    !/^wss?:$/.test(backend.protocol) ||
    !/^\/preview\/[a-f0-9]{64}\/$/.test(lease.endpoint) ||
    !/^[a-f0-9]{64}$/.test(lease.secret)
  )
    throw new Error("Invalid preview bridge endpoint");
  backend.protocol = backend.protocol === "wss:" ? "https:" : "http:";
  const host = `preview-${randomBytes(16).toString("hex")}.localhost`;
  const sockets = new Set<Socket>();
  const websockets = new Set<InstanceType<typeof WS.WebSocket>>();
  let port = 0;
  let closed = false;
  const permitted = (request: IncomingMessage, upgrade: boolean) => {
    const names = request.rawHeaders
      .filter((_value, index) => index % 2 === 0)
      .map((name) => name.toLowerCase());
    if (
      names.filter((name) => name === "host").length !== 1 ||
      names.filter((name) => name === "origin").length > 1 ||
      names.includes("x-cake-preview-bridge")
    )
      return false;
    if (request.headers.host !== `${host}:${port}`) return false;
    const origin = `http://${host}:${port}`;
    if (request.headers.origin !== undefined && request.headers.origin !== origin) return false;
    if (upgrade && request.headers.origin !== origin) return false;
    const raw = request.url ?? "";
    if (raw.length > 4096 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("#"))
      return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw.split("?", 1)[0] ?? "");
    } catch {
      return false;
    }
    return (
      !decoded.includes("%") &&
      !decoded.includes("\\") &&
      !decoded.includes("\0") &&
      !decoded.includes("//") &&
      !decoded.split("/").some((part) => part === "." || part === "..")
    );
  };
  const targetUrl = (path: string) =>
    new URL(lease.endpoint.slice(1) + path.slice(1), `${backend.origin}/`);
  const server = createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (closed || !permitted(request, false)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (
      !request.method ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)
    ) {
      response.writeHead(405);
      response.end();
      return;
    }
    if (Number(request.headers["content-length"]) > MAX_BODY) {
      response.writeHead(413);
      response.end();
      return;
    }
    const target = targetUrl(request.url ?? "/");
    const headers: OutgoingHttpHeaders = { "x-cake-preview-bridge": lease.secret };
    for (const name of [
      "accept",
      "accept-language",
      "content-type",
      "if-none-match",
      "if-modified-since",
      "range",
      "cookie",
    ] as const) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const upstream = (backend.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      { method: request.method, headers },
      (source) => {
        const length = Number(source.headers["content-length"]);
        if (length > MAX_BODY) {
          source.destroy();
          response.writeHead(502);
          response.end();
          return;
        }
        for (const name of [
          "content-type",
          "content-encoding",
          "etag",
          "last-modified",
          "content-range",
          "accept-ranges",
          "content-security-policy",
          "cross-origin-opener-policy",
          "cross-origin-embedder-policy",
          "set-cookie",
        ] as const) {
          const value = source.headers[name];
          if (value !== undefined) response.setHeader(name, value);
        }
        if (source.headers.location) {
          const redirect = new URL(source.headers.location, target);
          if (redirect.origin !== backend.origin) {
            source.destroy();
            response.writeHead(502);
            response.end();
            return;
          }
          response.setHeader(
            "Location",
            redirect.pathname.startsWith(lease.endpoint)
              ? redirect.pathname.slice(lease.endpoint.length - 1) + redirect.search
              : source.headers.location,
          );
        }
        response.setHeader("Referrer-Policy", "no-referrer");
        response.writeHead(source.statusCode ?? 502);
        let size = 0;
        source.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BODY) source.destroy(new Error("Preview response too large"));
        });
        source.on("error", () => response.destroy());
        source.pipe(response);
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("Preview upstream timeout")));
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.once("close", () => upstream.destroy());
    request.once("aborted", () => upstream.destroy());
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY) upstream.destroy(new Error("Preview request too large"));
    });
    request.pipe(upstream);
  });
  const wsServer = new WS.WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME,
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const protocol = request.headers["sec-websocket-protocol"];
    if (
      closed ||
      !permitted(request, true) ||
      request.method !== "GET" ||
      (protocol !== undefined &&
        (!Predicate.isString(protocol) ||
          protocol.length > 128 ||
          !/^[a-zA-Z0-9._-]+$/.test(protocol)))
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (downstream) => {
      websockets.add(downstream);
      const destination = targetUrl(request.url ?? "/");
      destination.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
      const upstream = new WS.WebSocket(destination, protocol, {
        headers: { "x-cake-preview-bridge": lease.secret },
        origin: backend.origin,
        perMessageDeflate: false,
        maxPayload: MAX_FRAME,
        handshakeTimeout: 10_000,
      });
      websockets.add(upstream);
      const close = () => {
        downstream.terminate();
        upstream.terminate();
        websockets.delete(downstream);
        websockets.delete(upstream);
      };
      downstream.pause();
      upstream.once("open", () => downstream.resume());
      for (const [from, to] of [
        [downstream, upstream],
        [upstream, downstream],
      ] as const) {
        from.on("message", (data, binary) => {
          const size = Array.isArray(data)
            ? data.reduce((sum, part) => sum + part.byteLength, 0)
            : data.byteLength;
          if (
            size > MAX_FRAME ||
            to.readyState !== WS.WebSocket.OPEN ||
            to.bufferedAmount > 4 * MAX_FRAME
          ) {
            close();
            return;
          }
          from.pause();
          to.send(data, { binary }, (error) => (error ? close() : from.resume()));
        });
        from.once("error", close);
        from.once("close", close);
      }
      if (closed) close();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    wsServer.close();
    throw error;
  }
  const address = server.address();
  if (!address || Predicate.isString(address)) {
    server.close();
    throw new Error("Native preview listener unavailable");
  }
  port = address.port;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const websocket of websockets) websocket.terminate();
    wsServer.close();
    server.close();
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
  };
  return { endpoint: `http://${host}:${port}/`, close };
}
