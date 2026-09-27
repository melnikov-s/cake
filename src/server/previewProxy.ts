import { NodeSocket } from "@effect/platform-node-shared";
import { Effect, Option, Predicate } from "effect";
import { Socket } from "effect/unstable/socket";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { PreviewLease, PreviewLeases } from "../services/browser/PreviewLeases";

const MAX_PATH = 4_096;
const MAX_BODY = 16 * 1024 * 1024;
const MAX_FRAME = 1024 * 1024;
const WS = NodeSocket.NodeWS;

/** The Cake-origin route is NOT a browser-facing document endpoint: it requires a
 * separate native-bridge secret on every HTTP request and WS upgrade. */
export function previewProxyTarget(
  previews: PreviewLeases["Service"],
  request: IncomingMessage,
): { lease: PreviewLease; path: string } | undefined {
  const raw = request.url ?? "";
  if (raw.length > MAX_PATH) return;
  const match = /^\/preview\/([a-f0-9]{64})(\/[^#]*)$/.exec(raw);
  if (!match) return;
  const path = match[2];
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
    decoded.includes("//") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  )
    return;
  const header = request.headers["x-cake-preview-bridge"];
  if (!Predicate.isString(header)) return;
  const names = request.rawHeaders
    .filter((_value, index) => index % 2 === 0)
    .map((name) => name.toLowerCase());
  if (names.filter((name) => name === "x-cake-preview-bridge").length !== 1) return;
  const id = match[1];
  if (!id) return;
  const lease = previews.find(id, header);
  return lease && { lease, path };
}

const forwarded = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "range",
  "cookie",
] as const;
const responseHeaders = [
  "content-type",
  "content-encoding",
  "etag",
  "last-modified",
  "content-range",
  "accept-ranges",
  "content-security-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
] as const;

/** Backpressure comes from the Node streams. Never forward Cake credentials,
 * authorization, arbitrary upstream hosts or application-supplied proxy headers. */
export function proxyPreviewHttp(
  request: IncomingMessage,
  response: ServerResponse,
  target: { lease: PreviewLease; path: string },
  listenerSignal: AbortSignal,
) {
  const signal = AbortSignal.any([listenerSignal, target.lease.revocation.signal]);
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
  const headers: Record<string, string | string[]> = {};
  for (const name of forwarded) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  // A native bridge explicitly supplies only cookies belonging to the isolated app origin.
  const upstream = httpRequest(
    `http://127.0.0.1:${target.lease.port}${target.path}`,
    {
      method: request.method,
      headers,
      signal,
    },
    (source) => {
      const length = Number(source.headers["content-length"]);
      if (length > MAX_BODY) {
        source.destroy();
        response.writeHead(502);
        response.end();
        return;
      }
      if (source.headers.location) {
        let location: URL;
        try {
          location = new URL(
            source.headers.location,
            `http://127.0.0.1:${target.lease.port}${target.path}`,
          );
        } catch {
          source.destroy();
          response.writeHead(502);
          response.end();
          return;
        }
        if (location.origin !== `http://127.0.0.1:${target.lease.port}`) {
          source.destroy();
          response.writeHead(502);
          response.end();
          return;
        }
        response.setHeader("Location", location.pathname + location.search);
      }
      for (const name of responseHeaders) {
        const value = source.headers[name];
        if (value !== undefined) response.setHeader(name, value);
      }
      // Domain cookies could escape the per-lease desktop hostname; host-only cookies cannot.
      const cookies = source.headers["set-cookie"]?.filter(
        (cookie) => !/(?:^|;)\s*domain\s*=/i.test(cookie),
      );
      if (cookies?.length) response.setHeader("Set-Cookie", cookies);
      response.setHeader("Referrer-Policy", "no-referrer");
      response.writeHead(source.statusCode ?? 502);
      let total = 0;
      source.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_BODY) source.destroy(new Error("Preview response too large"));
      });
      source.on("error", () => response.destroy());
      source.pipe(response);
    },
  );
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("Preview upstream timeout")));
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(signal.aborted ? 410 : 502);
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
}

/** Reuse the listener's existing WS adapter, not a second protocol on /rpc. */
export const proxyPreviewSocket = Effect.fn("PreviewProxy.socket")(function* (
  target: { lease: PreviewLease; path: string },
  protocol?: string,
) {
  const current = yield* Effect.serviceOption(Socket.WebSocket);
  if (Option.isNone(current) || !(current.value instanceof WS.WebSocket))
    return yield* Effect.die("Expected a Node preview WebSocket");
  const downstream = current.value;
  yield* Effect.callback<void>((resume) => {
    const upstream = new WS.WebSocket(
      `ws://127.0.0.1:${target.lease.port}${target.path}`,
      protocol,
      {
        origin: `http://127.0.0.1:${target.lease.port}`,
        perMessageDeflate: false,
        maxPayload: MAX_FRAME,
        handshakeTimeout: 10_000,
      },
    );
    const close = () => {
      upstream.terminate();
      downstream.terminate();
      resume(Effect.void);
    };
    target.lease.revocation.signal.addEventListener("abort", close, { once: true });
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
    if (target.lease.revocation.signal.aborted) close();
    return Effect.sync(() => {
      target.lease.revocation.signal.removeEventListener("abort", close);
      upstream.terminate();
      downstream.terminate();
    });
  });
});
