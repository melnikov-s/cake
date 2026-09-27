import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { NodeSocket } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { expect } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { openNativePreviewTunnel } from "../../src/services/browser/NativePreviewTunnel";
import { PreviewLeases, PreviewLeasesLive } from "../../src/services/browser/PreviewLeases";
import { ClientConnections } from "../../src/services/clients/ClientConnections";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";

const configuration = {
  homeDirectory: "/home/test",
  cakeChat: {
    agentDirectory: "/agent",
    location: cakeChatLocations.make({
      homeDirectory: "/home/test",
      sessionDirectory: "/chat",
      resolvedSessionDirectory: "/chat-resolved",
    }),
  },
};

it.live(
  "preview runs HTTP assets, POST and same-origin WS through only the fixed Cake endpoint without exposing the app under Cake origin",
  () =>
    Effect.gen(function* () {
      const source = createServer((request, response) => {
        if (request.url === "/")
          return response.end(`<script src="/app.js"></script><main>backend-only app</main>`);
        if (request.url === "/app.js") return response.end("window.backendApp = true");
        if (request.url === "/submit") {
          let body = "";
          request.on("data", (chunk) => (body += chunk.toString()));
          request.on("end", () =>
            response.end(`submitted:${body}:${request.headers.cookie ?? "none"}`),
          );
          return;
        }
        if (request.url === "/cookie") {
          response.setHeader("Set-Cookie", "app=dev; Path=/");
          return response.end("cookie");
        }
        response.end(`path:${request.url}`);
      });
      const sourceWs = new NodeSocket.NodeWS.WebSocketServer({ server: source });
      sourceWs.on("connection", (socket) =>
        socket.on("message", (data) => socket.send(`hmr:${socket.protocol}:${data}`)),
      );
      let sourcePort = 0;
      for (let candidate = 6500; candidate < 6600; candidate++) {
        try {
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                source.once("error", reject);
                source.listen(candidate, "127.0.0.1", resolve);
              }),
          );
          sourcePort = candidate;
          break;
        } catch {
          source.removeAllListeners("error");
        }
      }
      assert.ok(sourcePort);
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of sourceWs.clients) socket.terminate();
              sourceWs.close();
              source.closeAllConnections();
              source.close(() => resolve());
            }),
        ),
      );
      const backend = yield* makeNetworkTestBackend();
      const previews = Context.get(
        yield* Layer.build(
          PreviewLeasesLive.pipe(
            Layer.provide(
              Layer.succeed(ClientConnections, Context.get(backend.context, ClientConnections)),
            ),
          ),
        ),
        PreviewLeases,
      );
      const listener = yield* openNetworkListener(
        { port: 0, allowMissingOrigin: true },
        configuration,
        previews,
      ).pipe(Effect.provideContext(backend.context));
      assert.equal(listener.address._tag, "TcpAddress");
      const fixedPort = listener.address.port;
      const desktop = Context.get(backend.context, ClientConnections).desktop(12);
      const lease = yield* previews.acquire(desktop, "preview-session", sourcePort);
      const cakeUrl = `http://127.0.0.1:${fixedPort}`;
      const bridge = yield* Effect.promise(() =>
        openNativePreviewTunnel(`ws://127.0.0.1:${fixedPort}/rpc`, lease),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()));
      const local = new URL(bridge.endpoint);
      const http = (
        path: string,
        options: { method?: string; body?: string; headers?: Record<string, string> } = {},
      ) =>
        Effect.promise(
          () =>
            new Promise<{
              status: number;
              body: string;
              headers: Record<string, string | string[] | undefined>;
            }>((resolve, reject) => {
              const request = httpRequest(
                `http://127.0.0.1:${local.port}${path}`,
                {
                  method: options.method ?? "GET",
                  headers: { host: local.host, ...options.headers },
                },
                (response) => {
                  const chunks: Buffer[] = [];
                  response.on("data", (chunk: Buffer) => chunks.push(chunk));
                  response.on("end", () =>
                    resolve({
                      status: response.statusCode ?? 0,
                      body: Buffer.concat(chunks).toString(),
                      headers: response.headers,
                    }),
                  );
                },
              );
              request.once("error", reject);
              request.end(options.body);
            }),
        );
      expect((yield* http("/")).body).toContain("backend-only app");
      expect((yield* http("/app.js")).body).toBe("window.backendApp = true");
      expect((yield* http("/cookie")).headers["set-cookie"]).toEqual(["app=dev; Path=/"]);
      expect(
        (yield* http("/submit", {
          method: "POST",
          body: "clicked",
          headers: { cookie: "app=dev" },
        })).body,
      ).toBe("submitted:clicked:app=dev");
      expect(
        (yield* http("/", { headers: { host: `attacker.invalid:${local.port}` } })).status,
      ).toBe(403);
      expect((yield* http("/", { headers: { origin: "http://attacker.invalid" } })).status).toBe(
        403,
      );
      expect(
        (yield* http("/", { headers: { "x-cake-preview-bridge": lease.secret } })).status,
      ).toBe(403);
      expect((yield* http("/rpc")).body).toBe("path:/rpc");
      const bare = yield* Effect.promise(() => fetch(`${cakeUrl}${lease.endpoint}`));
      expect(bare.status).toBe(403);
      expect((yield* Effect.promise(() => bare.text())).toLowerCase()).not.toContain(
        "backend-only app",
      );
      const wrongSecret = yield* Effect.promise(() =>
        fetch(`${cakeUrl}${lease.endpoint}`, {
          headers: { "x-cake-preview-bridge": "0".repeat(64) },
        }),
      );
      expect(wrongSecret.status).toBe(403);
      const direct = yield* Effect.promise(() =>
        fetch(`${cakeUrl}${lease.endpoint}`, {
          headers: { "x-cake-preview-bridge": lease.secret },
        }),
      );
      expect(yield* Effect.promise(() => direct.text())).toContain("backend-only app");
      const wrongOrigin = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${local.port}/hot`, {
        origin: "http://attacker.invalid",
        headers: { Host: local.host },
      });
      expect(
        yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              wrongOrigin.once("unexpected-response", (_request, response) =>
                resolve(response.statusCode ?? 0),
              );
              wrongOrigin.once("error", reject);
            }),
        ),
      ).toBe(403);
      wrongOrigin.terminate();
      const ws = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${local.port}/hot`, "vite-hmr", {
        origin: bridge.endpoint.slice(0, -1),
        headers: { Host: local.host },
      });
      const exchange = yield* Effect.promise(
        () =>
          new Promise<string>((resolve, reject) => {
            ws.once("error", reject);
            ws.once("open", () => ws.send("change"));
            ws.once("message", (data) => resolve(String(data)));
          }),
      );
      expect(exchange).toBe("hmr:vite-hmr:change");
      expect((yield* http("/widget-assets/document/123")).body).toBe(
        "path:/widget-assets/document/123",
      );
      const closed = Effect.promise(
        () => new Promise<void>((resolve) => ws.once("close", () => resolve())),
      );
      yield* previews.releaseConnection(desktop);
      Context.get(backend.context, ClientConnections).release(desktop);
      yield* closed.pipe(Effect.timeout("2 seconds"));
      expect((yield* http("/")).status).toBe(403);
      const replacement = Context.get(backend.context, ClientConnections).desktop(12);
      expect(replacement).not.toBe(desktop);
      const fresh = yield* previews.acquire(replacement, "preview-session", sourcePort);
      expect(fresh.secret).not.toBe(lease.secret);
      expect((yield* http("/")).status).toBe(403);
      yield* listener.close();
    }).pipe(Effect.scoped),
  30_000,
);
