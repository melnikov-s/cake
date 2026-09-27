import { NodeSocketServer } from "@effect/platform-node-shared";
import { Effect, Exit, Layer, Option, Predicate, Result, Schema, Scope } from "effect";
import { RpcSerialization } from "effect/unstable/rpc";
import { Socket, SocketServer } from "effect/unstable/socket";
import { createServer, type IncomingMessage } from "node:http";
import { browserAssetAt, loadBrowserAssets } from "./browserAssets";
import { inlineWidgetDocument } from "../services/widgets/inline-widget-document-registry";
import { extensionCompanionModuleSource } from "../services/pi/runtime/extension-companion-module-registry";
import { inlineWidgetContentSecurityPolicy } from "../services/electron/inline-widget-policy";
import { VsCodeServer } from "../services/vscode/VsCodeServer";
import { editorProxyTarget, proxyEditorHttp, proxyEditorSocket } from "./editorProxy";
import { EditorBrowserPort } from "./EditorBrowserPort";
import type { VsCodeServer as VsCodeServerType } from "../services/vscode/VsCodeServer";
import { previewProxyTarget, proxyPreviewHttp, proxyPreviewSocket } from "./previewProxy";
import type { CakeChatRuntimeConfiguration } from "../domain/cake-chats/cakeChatRuntime";
import { makeBackendRpcServerLive } from "../ipc/server/BackendRpcServer";
import { StandaloneSocketProtocolLive } from "../ipc/transport/StandaloneSocketProtocol";
import { parseRendererRpcMessage } from "../ipc/transport/ElectronRpcTransport";
import { cakeRpcPayloadSchemas } from "../ipc/cake-rpc-contract";
import { RendererRequestCoordinator } from "../services/renderer-requests/RendererRequestCoordinator";
import type { PreviewLeases } from "../services/browser/PreviewLeases";

const exactHost = Schema.NonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(`http://${value}`);
        return (
          !value.includes("*") &&
          (url.host === value.toLowerCase() || `${url.hostname}:80` === value.toLowerCase()) &&
          url.pathname === "/" &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Expected an exact Host authority (hostname with optional port), not a wildcard or URL",
    },
  ),
);
const exactOrigin = Schema.NonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.origin === value &&
          !value.includes("*")
        );
      } catch {
        return false;
      }
    },
    { message: "Expected an exact http(s) origin without a path or wildcard" },
  ),
);

export const NetworkListenerOptions = Schema.Struct({
  browserAssetsDirectory: Schema.optionalKey(Schema.NonEmptyString),
  bind: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(253))),
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  path: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^\/[a-zA-Z0-9/_-]+$/), Schema.isMaxLength(256)),
  ),
  allowedHosts: Schema.optionalKey(Schema.Array(exactHost).check(Schema.isMaxLength(64))),
  allowedOrigins: Schema.optionalKey(Schema.Array(exactOrigin).check(Schema.isMaxLength(64))),
  editorPort: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  ),
  editorPublicOrigin: Schema.optionalKey(
    exactOrigin.check(
      Schema.makeFilter((value) => value.startsWith("https://"), {
        message: "Expected an exact HTTPS editor origin",
      }),
    ),
  ),
  allowMissingOrigin: Schema.optionalKey(Schema.Boolean),
  maxPayloadBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 16 * 1024 * 1024 })),
  ),
});
export interface NetworkListenerOptions extends Schema.Schema.Type<typeof NetworkListenerOptions> {}

export class NetworkListenerError extends Schema.TaggedError<NetworkListenerError>()(
  "NetworkListenerError",
  {
    message: Schema.String,
  },
) {}

/** Explicitly invoked by a host, never on import. Owns sockets/requests only.
 * Supply acquired backend Services in the caller's Context, NOT a new backend Layer.
 * No auth: each accepted connection has full backend authority. Shared ClientConnections
 * safely separates socket identities from simultaneous desktop IPC identities.
 */
export const openNetworkListener = Effect.fn("NetworkListener.open")(function* (
  input: NetworkListenerOptions,
  configuration: {
    readonly homeDirectory: string;
    readonly cakeChat: CakeChatRuntimeConfiguration;
  },
  previews?: PreviewLeases["Service"],
) {
  const options = yield* Schema.decodeUnknownEffect(NetworkListenerOptions)(input).pipe(
    Effect.mapError(
      (error) =>
        new NetworkListenerError({
          message: `Invalid network listener configuration: ${error.message}`,
        }),
    ),
  );
  const bind = options.bind ?? "127.0.0.1";
  const path = options.path ?? "/rpc";
  if (options.editorPublicOrigin) {
    const editorHostname = new URL(options.editorPublicOrigin).hostname.toLowerCase();
    const appHosts = options.allowedHosts ?? [bind];
    if (
      !options.browserAssetsDirectory ||
      !options.editorPort ||
      options.allowedOrigins?.includes(options.editorPublicOrigin) ||
      appHosts.some(
        (host) => new URL(`http://${host}`).hostname.toLowerCase() === editorHostname,
      ) ||
      options.allowedOrigins?.some(
        (origin) => new URL(origin).hostname.toLowerCase() === editorHostname,
      )
    )
      return yield* new NetworkListenerError({
        message:
          "Public editor requires browser assets, a fixed editor port, and an origin and Host distinct from the application",
      });
  }
  const scope = yield* Scope.fork(yield* Effect.scope);
  const acquire = Effect.gen(function* () {
    const editor = yield* VsCodeServer;
    const requests = yield* RendererRequestCoordinator;
    if (previews) yield* Effect.addFinalizer(() => previews.shutdown());
    const listenerAbort = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => listenerAbort.abort()));
    const assets = options.browserAssetsDirectory
      ? yield* loadBrowserAssets(options.browserAssetsDirectory)
      : undefined;
    const isolatedEditor = assets !== undefined;
    const editorServer = isolatedEditor
      ? yield* openIsolatedEditorListener(
          bind,
          options.allowedHosts,
          options.editorPort ?? 0,
          options.editorPublicOrigin,
          editor,
          listenerAbort.signal,
        )
      : undefined;
    const editorPort = editorServer?.port;
    const directEditorOrigins =
      editorPort === undefined
        ? []
        : (options.allowedHosts ?? [bind]).map((host) => {
            const authority = host === bind ? bracketHost(host) : host;
            const hostname = bracketHost(new URL(`http://${authority}`).hostname);
            return `http://${hostname}:${editorPort}`;
          });
    const refusal = (request: IncomingMessage, upgrade: boolean): string | undefined => {
      const names = request.rawHeaders
        .filter((_value, index) => index % 2 === 0)
        .map((name) => name.toLowerCase());
      if (
        names.filter((name) => name === "host").length !== 1 ||
        names.filter((name) => name === "origin").length > 1
      )
        return "Ambiguous Host or Origin";
      const authority = `${bind.includes(":") ? `[${bind}]` : bind}:${request.socket.localPort}`;
      const hosts = options.allowedHosts?.map((entry) => entry.toLowerCase()) ?? [
        new URL(`http://${authority}`).host,
      ];
      const host = request.headers.host?.toLowerCase();
      if (!host || !hosts.includes(host)) return "Unexpected Host";
      const origin = request.headers.origin;
      // Serving explicitly enables exact HTTP same-origin access. Explicit origins replace this default.
      const editorRoute = !isolatedEditor && request.url?.startsWith("/editor/") === true;
      const previewRoute = request.url?.startsWith("/preview/") === true;
      const origins =
        editorRoute || previewRoute
          ? [new URL(`http://${host}`).origin, new URL(`https://${host}`).origin]
          : (options.allowedOrigins ?? (assets ? [new URL(`http://${host}`).origin] : []));
      if (
        origin === undefined
          ? upgrade && (editorRoute || previewRoute || options.allowMissingOrigin !== true)
          : origin === options.editorPublicOrigin ||
            directEditorOrigins.includes(origin) ||
            !origins.includes(origin)
      )
        return "Unexpected Origin";
      return undefined;
    };
    const http = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          const denied = refusal(request, false);
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader("Cache-Control", "no-store");
          if (denied) {
            response.writeHead(403);
            response.end(denied);
            return;
          }
          if (request.url?.startsWith("/preview/")) {
            const target = previews && previewProxyTarget(previews, request);
            if (!target) {
              response.writeHead(403);
              response.end("Invalid preview lease or bridge");
              return;
            }
            proxyPreviewHttp(request, response, target, listenerAbort.signal);
            return;
          }
          if (!isolatedEditor && request.url?.startsWith("/editor/")) {
            const target = editorProxyTarget(editor, request.url);
            if (!target) {
              response.writeHead(403);
              response.end("Invalid editor lease or route");
              return;
            }
            proxyEditorHttp(request, response, target, listenerAbort.signal);
            return;
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { Allow: "GET, HEAD" });
            response.end();
            return;
          }
          // Exact, capability-addressed in-memory publications only. Never proxy a path or
          // read a workspace file on behalf of a sandboxed frame.
          const widgetToken = /^\/widget-assets\/document\/([0-9a-f-]{36})$/.exec(
            request.url ?? "",
          )?.[1];
          const moduleToken = /^\/widget-assets\/module\/([0-9a-f]{64})$/.exec(
            request.url ?? "",
          )?.[1];
          const document = widgetToken ? inlineWidgetDocument(widgetToken) : undefined;
          const module = moduleToken ? extensionCompanionModuleSource(moduleToken) : undefined;
          if (document !== undefined || module !== undefined) {
            const body = Buffer.from(document ?? module ?? "", "utf8");
            response.setHeader(
              "Content-Type",
              document !== undefined
                ? "text/html; charset=utf-8"
                : "text/javascript; charset=utf-8",
            );
            response.setHeader("Content-Length", body.byteLength);
            response.setHeader("Referrer-Policy", "no-referrer");
            if (document !== undefined)
              response.setHeader("Content-Security-Policy", inlineWidgetContentSecurityPolicy);
            response.writeHead(200);
            response.end(request.method === "HEAD" ? undefined : body);
            return;
          }
          const asset = assets && browserAssetAt(assets, request.url ?? "");
          if (!asset) {
            response.writeHead(404);
            response.end("Not found");
            return;
          }
          response.setHeader("Content-Type", asset.contentType);
          response.setHeader("Content-Length", asset.body.byteLength);
          const browserHost = bracketHost(new URL(`http://${request.headers.host}`).hostname);
          const frameOrigin =
            editorPort === undefined
              ? "'none'"
              : [`http://${browserHost}:${editorPort}`, options.editorPublicOrigin]
                  .filter((origin) => origin !== undefined)
                  .join(" ");
          response.setHeader(
            "Content-Security-Policy",
            `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob: ${frameOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
          );
          response.writeHead(200);
          response.end(request.method === "HEAD" ? undefined : asset.body);
        }),
      ),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          server.closeAllConnections();
        }),
    );
    const [socketServer] = yield* Effect.all(
      [
        NodeSocketServer.makeWebSocket({
          server: http,
          // The editor's extension-host initialization exceeds the RPC message cap.
          // RPC keeps its own stricter bound before decoding below.
          maxPayload: 16 * 1024 * 1024,
          perMessageDeflate: false,
          // ws validates Upgrade/method/version; these checks precede its upgrade acceptance.
          verifyClient: (info, done) => {
            const previewRoute = info.req.url?.startsWith("/preview/") === true;
            if (
              info.req.url !== path &&
              (isolatedEditor || !editorProxyTarget(editor, info.req.url ?? "", true)) &&
              !previewRoute
            )
              return done(false, 404, "Unknown RPC, editor or preview path");
            const denied = refusal(info.req, true);
            if (denied) return done(false, 403, denied);
            if (previewRoute && (!previews || !previewProxyTarget(previews, info.req)))
              return done(false, 403, "Invalid preview lease or bridge");
            done(true);
          },
        }),
        Effect.callback<void, NetworkListenerError>((resume) => {
          http.once("error", (error) =>
            resume(
              Effect.fail(
                new NetworkListenerError({
                  message: `Cannot listen on ${bind}:${options.port}: ${String(error)}`,
                }),
              ),
            ),
          );
          http.listen(options.port, bind, () => resume(Effect.void));
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError(
        (error) =>
          new NetworkListenerError({
            message: `Cannot listen on ${bind}:${options.port}: ${error._tag === "NetworkListenerError" ? error.message : String(error.reason.cause)}`,
          }),
      ),
    );
    if (previews) yield* previews.configure();
    const ownedSockets = SocketServer.SocketServer.of({
      ...socketServer,
      run: (handler) =>
        socketServer.run((socket) =>
          Effect.gen(function* () {
            // NodeSocketServer supplies IncomingMessage at runtime but SocketServer.run's generic
            // signature does not express that provided service.
            const request = yield* Effect.serviceOption(NodeSocketServer.IncomingMessage);
            if (Option.isNone(request))
              return yield* Effect.die("Node WebSocket request context missing");
            // Closing a listener must not wait for a peer to finish a WebSocket close handshake.
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                request.value.socket.destroy();
              }),
            );
            if (request.value.url?.startsWith("/preview/")) {
              const target = previews && previewProxyTarget(previews, request.value);
              if (!target) return;
              const protocol = request.value.headers["sec-websocket-protocol"];
              if (
                protocol !== undefined &&
                (!Predicate.isString(protocol) ||
                  protocol.length > 128 ||
                  !/^[a-zA-Z0-9._-]+$/.test(protocol))
              )
                return;
              return yield* proxyPreviewSocket(target, protocol);
            }
            if (request.value.url !== path) {
              const target = isolatedEditor
                ? undefined
                : editorProxyTarget(editor, request.value.url ?? "", true);
              if (!target) return;
              return yield* proxyEditorSocket(target);
            }
            const bounded = Socket.make({
              writer: socket.writer,
              runRaw: <A, E, R>(
                consume: (data: string | Uint8Array) => Effect.Effect<A, E, R> | void,
                config?: { readonly onOpen?: Effect.Effect<void> },
              ) =>
                socket.runRaw<unknown, E | Socket.SocketError, R>((data) => {
                  const size = Predicate.isString(data) ? Buffer.byteLength(data) : data.byteLength;
                  // Ordinary RPC retains its configured ceiling. Only a pending targeted
                  // widget PNG or browser screenshot can use the separate 12-MiB image cap.
                  const capturePayload = (() => {
                    if (size <= 1024 * 1024 || size > 12 * 1024 * 1024) return undefined;
                    try {
                      const parsed = parseRendererRpcMessage(
                        JSON.parse(
                          Predicate.isString(data) ? data : Buffer.from(data).toString("utf8"),
                        ),
                      );
                      if (
                        Result.isFailure(parsed) ||
                        parsed.success._tag !== "Request" ||
                        parsed.success.tag !== "widgets.respond-widget-capture"
                      )
                        return undefined;
                      const payload = Schema.decodeUnknownOption(
                        cakeRpcPayloadSchemas["respond-widget-capture"],
                      )(parsed.success.payload);
                      return Option.isSome(payload) ? payload.value : undefined;
                    } catch {
                      return undefined;
                    }
                  })();
                  const browserScreenshot = (() => {
                    if (size <= 1024 * 1024 || size > 12 * 1024 * 1024) return undefined;
                    try {
                      const parsed = parseRendererRpcMessage(
                        JSON.parse(
                          Predicate.isString(data) ? data : Buffer.from(data).toString("utf8"),
                        ),
                      );
                      if (
                        Result.isFailure(parsed) ||
                        parsed.success._tag !== "Request" ||
                        parsed.success.tag !== "browser.respond-browser-native"
                      )
                        return undefined;
                      const payload = Schema.decodeUnknownOption(
                        cakeRpcPayloadSchemas["respond-browser-native"],
                      )(parsed.success.payload);
                      if (Option.isNone(payload) || payload.value.result.status !== "completed")
                        return undefined;
                      const screenshot = Schema.decodeUnknownOption(
                        Schema.Struct({
                          data: Schema.String.check(Schema.isMaxLength(11_000_000)),
                        }),
                      )(payload.value.result.value);
                      if (Option.isNone(screenshot)) return undefined;
                      return payload.value;
                    } catch {
                      return undefined;
                    }
                  })();
                  return Effect.flatMap(
                    capturePayload
                      ? requests.hasPendingWidgetCapture(
                          capturePayload.requestId,
                          capturePayload.sessionId,
                        )
                      : browserScreenshot
                        ? requests.hasPendingBrowserScreenshot(
                            browserScreenshot.requestId,
                            browserScreenshot.sessionId,
                          )
                        : Effect.succeed(false),
                    (largeCapture): Effect.Effect<unknown, E | Socket.SocketError, R> =>
                      size >
                      (largeCapture ? 12 * 1024 * 1024 : (options.maxPayloadBytes ?? 1024 * 1024))
                        ? socket.writer.pipe(
                            Effect.flatMap((write) =>
                              write(new Socket.CloseEvent(1009, "RPC message too large")),
                            ),
                            Effect.scoped,
                          )
                        : (consume(data) ?? Effect.void),
                  );
                }, config),
            });
            return yield* handler(bounded);
          }).pipe(Effect.scoped),
        ),
    });
    const protocol = StandaloneSocketProtocolLive.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(SocketServer.SocketServer, ownedSockets),
          RpcSerialization.layerJson,
        ),
      ),
    );
    yield* Layer.buildWithScope(
      makeBackendRpcServerLive(configuration.homeDirectory, configuration.cakeChat).pipe(
        Layer.provide(protocol),
        Layer.provide(
          Layer.succeed(EditorBrowserPort, {
            port: editorPort,
            publicOrigin: options.editorPublicOrigin,
          }),
        ),
      ),
      scope,
    );
    return { address: socketServer.address, editorPort };
  });
  const address = yield* acquire.pipe(
    Scope.provide(scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  );
  return {
    address: address.address,
    path,
    editorPort: address.editorPort,
    close: () => Scope.close(scope, Exit.void),
  };
});

/** The browser editor is a separate, editor-only HTTP origin. The scope owning the
 * application listener also closes this socket and every proxied request. */
const openIsolatedEditorListener = Effect.fn("NetworkListener.editor")(function* (
  bind: string,
  allowedHosts: ReadonlyArray<string> | undefined,
  configuredPort: number,
  publicOrigin: string | undefined,
  editor: VsCodeServerType["Service"],
  signal: AbortSignal,
) {
  const http = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createServer((request, response) => {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "no-store");
        const denied = refuseEditorRequest(request, bind, allowedHosts, publicOrigin);
        if (denied) {
          response.writeHead(403);
          response.end(denied);
          return;
        }
        const target = editorProxyTarget(editor, request.url ?? "");
        if (!target) {
          response.writeHead(403);
          response.end("Invalid editor lease or route");
          return;
        }
        proxyEditorHttp(request, response, target, signal);
      }),
    ),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
  const [socketServer] = yield* Effect.all(
    [
      NodeSocketServer.makeWebSocket({
        server: http,
        maxPayload: 16 * 1024 * 1024,
        perMessageDeflate: false,
        verifyClient: (info, done) => {
          const denied = refuseEditorRequest(info.req, bind, allowedHosts, publicOrigin);
          if (denied) return done(false, 403, denied);
          if (!editorProxyTarget(editor, info.req.url ?? "", true))
            return done(false, 404, "Invalid editor lease or socket path");
          done(true);
        },
      }),
      Effect.callback<void, NetworkListenerError>((resume) => {
        http.once("error", (error) =>
          resume(
            Effect.fail(
              new NetworkListenerError({
                message: `Cannot listen on editor ${bind}:${configuredPort}: ${String(error)}`,
              }),
            ),
          ),
        );
        http.listen(configuredPort, bind, () => resume(Effect.void));
      }),
    ],
    { concurrency: "unbounded" },
  );
  yield* socketServer
    .run(() =>
      Effect.gen(function* () {
        const request = yield* Effect.serviceOption(NodeSocketServer.IncomingMessage);
        if (Option.isNone(request)) return yield* Effect.die("Node editor request missing");
        yield* Effect.addFinalizer(() => Effect.sync(() => request.value.socket.destroy()));
        const target = editorProxyTarget(editor, request.value.url ?? "", true);
        if (target) yield* proxyEditorSocket(target);
      }).pipe(Effect.scoped),
    )
    .pipe(Effect.forkScoped);
  const address = socketServer.address;
  if (address._tag !== "TcpAddress")
    return yield* new NetworkListenerError({
      message: "Editor listener did not acquire a TCP port",
    });
  return { port: address.port };
});

function bracketHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function refuseEditorRequest(
  request: IncomingMessage,
  bind: string,
  allowedHosts: ReadonlyArray<string> | undefined,
  publicOrigin: string | undefined,
): string | undefined {
  const names = request.rawHeaders
    .filter((_value, index) => index % 2 === 0)
    .map((name) => name.toLowerCase());
  if (
    names.filter((name) => name === "host").length !== 1 ||
    names.filter((name) => name === "origin").length > 1
  )
    return "Ambiguous Host or Origin";
  const port = request.socket.localPort;
  if (!request.socket.localAddress || !port) return "Unexpected socket address";
  const host = request.headers.host?.toLowerCase();
  const hostnames = allowedHosts?.map((entry) => new URL(`http://${entry}`).hostname) ?? [bind];
  const expectedHosts = hostnames.map((name) => `${bracketHost(name)}:${port}`.toLowerCase());
  const external = publicOrigin !== undefined && host === new URL(publicOrigin).host;
  if (!host || (!expectedHosts.includes(host) && !external)) return "Unexpected Host";
  const origin = request.headers.origin;
  const expected = external ? publicOrigin : `http://${host}`;
  if (origin !== undefined && origin !== expected) return "Unexpected Origin";
  if (request.headers.upgrade && origin !== expected) return "Missing editor socket Origin";
  return undefined;
}
