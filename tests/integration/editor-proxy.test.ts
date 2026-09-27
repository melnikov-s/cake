import { NodeSocket } from "@effect/platform-node-shared";
import { Context, Effect } from "effect";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { editorLeasePath } from "../../src/server/editorProxy";
import { VsCodeServer } from "../../src/services/vscode/VsCodeServer";
import type { VsCodeLease } from "../../src/services/vscode/VsCodeServerRuntime";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

/** Controlled code-server boundary, not qualification of VS Code itself. Real
 * listener, raw-header policy, proxy streams, socket bridge and lease revocation. */
it("leased editor HTTP/WS preserves base paths and bytes, refuses wrong owners/routes/origins, and revokes live resources", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seen: { path: string; headers: IncomingMessage["headers"] }[] = [];
      const upstream = createServer((req, res) => {
        seen.push({ path: req.url ?? "", headers: req.headers });
        if (req.url === "/") {
          res.writeHead(302, { location: "/?folder=%2Fserver%2Fworkspace" });
          res.end();
        } else if (req.url === "/static/stream") {
          res.writeHead(200);
          res.write("first");
        } else {
          res.writeHead(200, {
            "content-type": "application/javascript",
            "set-cookie": "internal=secret",
            "service-worker-allowed": "/",
          });
          res.end(req.url);
        }
      });
      const sockets = new NodeSocket.NodeWS.WebSocketServer({
        server: upstream,
        perMessageDeflate: false,
      });
      sockets.on("connection", (socket) =>
        socket.on("message", (bytes, binary) => socket.send(bytes, { binary })),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of sockets.clients) socket.terminate();
              sockets.close();
              upstream.closeAllConnections();
              upstream.close(() => resolve());
            }),
        ),
      );
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("No upstream address");
      const lease: VsCodeLease = {
        id: "a".repeat(64),
        connectionId: 42,
        workspacePath: "/server/workspace",
        presentedWorkspacePath: "/server/workspace",
        url: `http://127.0.0.1:${address.port}/`,
        flavor: "codeserver",
        visible: false,
        revocation: new AbortController(),
      };
      let activeLease = lease;
      const fixture = yield* makeNetworkTestBackend();
      const context = Context.add(fixture.context, VsCodeServer, {
        ...Context.get(fixture.context, VsCodeServer),
        leaseFor: (id) => (id === activeLease.connectionId ? activeLease : undefined),
      });
      const listener = yield* openNetworkListener(
        { port: 0, allowMissingOrigin: true },
        {
          homeDirectory: "/home/test",
          cakeChat: {
            agentDirectory: "/agent",
            location: cakeChatLocations.make({
              homeDirectory: "/home/test",
              sessionDirectory: "/chat",
              resolvedSessionDirectory: "/chat-resolved",
            }),
          },
        },
      ).pipe(Effect.provide(context));
      if (listener.address._tag !== "TcpAddress") throw new Error("No listener address");
      const port = listener.address.port;
      const origin = `http://127.0.0.1:${port}`;
      const prefix = editorLeasePath(lease);
      const get = (path: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>(
          (resolve, reject) => {
            const req = request(origin + path, { headers }, (res) => {
              let body = "";
              res.on("data", (chunk) => {
                body += chunk.toString();
              });
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
              );
            });
            req.on("error", reject);
            req.end();
          },
        );
      const raw = (headers: string) =>
        new Promise<string>((resolve, reject) => {
          const socket = connect(port, "127.0.0.1", () =>
            socket.end(`GET ${prefix} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`),
          );
          let body = "";
          socket.on("data", (chunk) => {
            body += chunk.toString();
          });
          socket.on("end", () => resolve(body));
          socket.on("error", reject);
        });
      yield* Effect.promise(async () => {
        const root = await get(prefix);
        expect(root.status).toBe(302);
        expect(root.headers.location).toBe(prefix + "?folder=%2Fserver%2Fworkspace");
        const asset = await get(prefix + "stable-" + "b".repeat(40) + "/static/workbench.js?v=1", {
          origin,
          cookie: "do-not-forward",
          authorization: "Bearer do-not-forward",
          "x-forwarded-host": "attacker.example",
        });
        expect(asset).toMatchObject({
          status: 200,
          body: "/stable-" + "b".repeat(40) + "/static/workbench.js?v=1",
        });
        expect(asset.headers["set-cookie"]).toBeUndefined();
        expect(asset.headers["service-worker-allowed"]).toBe(prefix);
        expect(seen.at(-1)?.headers).not.toHaveProperty("cookie");
        expect(seen.at(-1)?.headers).not.toHaveProperty("authorization");
        expect(seen.at(-1)?.headers).not.toHaveProperty("x-forwarded-host");
        const accepted = seen.length;
        for (const path of [
          prefix.replace("/42/", "/43/"),
          prefix.replace(lease.id, "b".repeat(64)),
          prefix + "proxy/1234/",
          prefix + "absproxy/1234/",
          prefix + "%70roxy/1234/",
          prefix + "static/%2e%2e/proxy/1234",
          prefix + "static/%252e%252e/proxy/1234",
          prefix + "update",
          prefix + "vscode/proxy/1234/",
          prefix + "/proxy/1234/",
          prefix + "http://127.0.0.1:1234/",
          prefix + "?folder=/other-workspace",
          prefix + "?workspace=/other.code-workspace",
          prefix + "?folder=/server/workspace&folder=/other-workspace",
        ])
          expect((await get(path)).status, path).toBe(403);
        expect((await get(prefix, { origin: "http://evil.example" })).status).toBe(403);
        expect((await get(prefix, { host: "evil.example" })).status).toBe(403);
        expect(await raw(`Host: 127.0.0.1:${port}\r\nHost: evil.example`)).toContain("403");
        expect(
          await raw(`Host: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nOrigin: ${origin}`),
        ).toContain("403");
        expect(seen).toHaveLength(accepted);
      });
      const socketUrl =
        origin.replace("http:", "ws:") +
        prefix +
        "stable-" +
        "b".repeat(40) +
        "?reconnectionToken=test&skipWebSocketFrames=false";
      const rejectedSocket = (url: string, origin?: string) =>
        new Promise<number>((resolve, reject) => {
          const socket = new NodeSocket.NodeWS.WebSocket(url, origin ? { origin } : undefined);
          socket.once("unexpected-response", (_request, response) => {
            response.resume();
            socket.terminate();
            resolve(response.statusCode ?? 0);
          });
          socket.on("error", () => {});
          socket.once("open", () => {
            socket.terminate();
            reject(new Error("Unexpected accepted socket"));
          });
        });
      yield* Effect.promise(async () => {
        expect(await rejectedSocket(socketUrl, "http://evil.example")).toBe(403);
        expect(await rejectedSocket(socketUrl)).toBe(403);
        expect(await rejectedSocket(socketUrl.replace("/42/", "/43/"), origin)).toBe(404);
        expect(
          await rejectedSocket(origin.replace("http:", "ws:") + prefix + "proxy/1234/", origin),
        ).toBe(404);
        expect(
          await rejectedSocket(
            origin.replace("http:", "ws:") + prefix + "static/workbench.js",
            origin,
          ),
        ).toBe(404);
      });
      const socket = new NodeSocket.NodeWS.WebSocket(socketUrl, { origin });
      yield* Effect.addFinalizer(() => Effect.sync(() => socket.terminate()));
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          }),
      );
      yield* Effect.promise(async () => {
        // Larger than RPC's cap: supported code-server extension initialization needs this.
        for (const data of ["hello", Buffer.alloc(2 * 1024 * 1024, 42)]) {
          const echoed = new Promise<void>((resolve, reject) => {
            socket.once("message", (bytes, binary) => {
              try {
                expect(binary).toBe(typeof data !== "string");
                expect(bytes.toString()).toBe(data.toString());
                resolve();
              } catch (error) {
                reject(error);
              }
            });
            socket.once("error", reject);
          });
          socket.send(data);
          await echoed;
        }
        let streamClosed: Promise<void> | undefined;
        await new Promise<void>((resolve, reject) => {
          const req = request(origin + prefix + "static/stream", (response) => {
            streamClosed = new Promise<void>((resolve) => response.once("close", resolve));
            response.once("data", () => resolve());
            response.on("error", () => {});
          });
          req.on("error", reject);
          req.end();
        });
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        lease.revocation.abort();
        await closed;
        await streamClosed;
        expect((await get(prefix)).status).toBe(403);
        expect(await rejectedSocket(socketUrl, origin)).toBe(404);
      });
      yield* Effect.promise(async () => {
        const rpc = new NodeSocket.NodeWS.WebSocket(origin.replace("http:", "ws:") + "/rpc");
        await new Promise<void>((resolve, reject) => {
          rpc.once("open", resolve);
          rpc.once("error", reject);
        });
        const closed = new Promise<void>((resolve) => rpc.once("close", () => resolve()));
        rpc.send(" ".repeat(2 * 1024 * 1024));
        await closed;
      });
      activeLease = { ...lease, id: "c".repeat(64), revocation: new AbortController() };
      const remaining = new NodeSocket.NodeWS.WebSocket(
        origin.replace("http:", "ws:") + editorLeasePath(activeLease),
        { origin },
      );
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            remaining.once("open", resolve);
            remaining.once("error", reject);
          }),
      );
      const closed = new Promise<void>((resolve) => remaining.once("close", () => resolve()));
      yield* listener.close();
      yield* Effect.promise(() => closed);
    }).pipe(Effect.scoped),
  );
}, 20_000);
