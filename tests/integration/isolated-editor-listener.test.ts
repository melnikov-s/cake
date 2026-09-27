import { NodeSocket } from "@effect/platform-node-shared";
import { Context, Effect } from "effect";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { editorLeasePath } from "../../src/server/editorProxy";
import { VsCodeServer } from "../../src/services/vscode/VsCodeServer";
import type { VsCodeLease } from "../../src/services/vscode/VsCodeServerRuntime";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { connectClient } from "./fixtures/network-client";

it("isolates leased editor HTTP and WS from browser assets and RPC, then revokes them", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-editor-origin-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() => mkdir(join(root, "assets")));
      yield* Effect.promise(() => writeFile(join(root, "index.html"), "browser application"));
      const upstream = createServer((req, res) => res.end(`editor:${req.url}`));
      const upstreamSockets = new NodeSocket.NodeWS.WebSocketServer({ server: upstream });
      upstreamSockets.on("connection", (socket) =>
        socket.on("message", (message) => socket.send(message)),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of upstreamSockets.clients) socket.terminate();
              upstreamSockets.close();
              upstream.closeAllConnections();
              upstream.close(() => resolve());
            }),
        ),
      );
      const upstreamAddress = upstream.address();
      if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("No upstream");
      const lease: VsCodeLease = {
        id: "a".repeat(64),
        connectionId: 42,
        workspacePath: "/workspace",
        presentedWorkspacePath: "/workspace",
        url: `http://127.0.0.1:${upstreamAddress.port}/`,
        flavor: "codeserver",
        visible: false,
        revocation: new AbortController(),
      };
      let activeLease = lease;
      const fixture = yield* makeNetworkTestBackend();
      const backend = Context.add(fixture.context, VsCodeServer, {
        ...Context.get(fixture.context, VsCodeServer),
        leaseFor: (id) => (id === activeLease.connectionId ? activeLease : undefined),
        acquire: () => Effect.succeed(lease),
      });
      const listener = yield* openNetworkListener(
        { port: 0, browserAssetsDirectory: root },
        {
          homeDirectory: "/home/test",
          cakeChat: {
            agentDirectory: "/agent",
            location: cakeChatLocations.make({
              homeDirectory: "/home/test",
              sessionDirectory: "/chat",
              resolvedSessionDirectory: "/resolved",
            }),
          },
        },
      ).pipe(Effect.provide(backend));
      if (listener.address._tag !== "TcpAddress" || listener.editorPort === undefined)
        throw new Error("Isolated listeners missing");
      const appPort = listener.address.port;
      const app = `http://127.0.0.1:${appPort}`;
      const editorPort = listener.editorPort;
      const editor = `http://127.0.0.1:${editorPort}`;
      const prefix = editorLeasePath(lease);
      const { client } = yield* connectClient(app.replace("http:", "ws:") + "/rpc", app);
      const acquired = yield* client["vscode.acquire"]({
        requestId: crypto.randomUUID(),
        workspacePath: "/project",
        theme: "dark",
      });
      expect(acquired.editorPort).toBe(listener.editorPort);
      expect(acquired.endpoint).toMatch(/^\/editor\/[1-9][0-9]*\/[a-f0-9]{64}\/$/);
      const get = (url: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; body: string; csp?: string }>((resolve, reject) => {
          request(url, { headers }, (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk.toString()));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body,
                csp: response.headers["content-security-policy"]?.toString(),
              }),
            );
          })
            .on("error", reject)
            .end();
        });
      const raw = (headers: string) =>
        new Promise<string>((resolve, reject) => {
          const socket = connect(editorPort, "127.0.0.1", () =>
            socket.end(`GET ${prefix} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`),
          );
          let body = "";
          socket.on("data", (chunk) => (body += chunk.toString()));
          socket.on("end", () => resolve(body));
          socket.on("error", reject);
        });
      const deniedSocket = (url: string, origin: string) =>
        new Promise<number>((resolve, reject) => {
          const socket = new NodeSocket.NodeWS.WebSocket(url, { origin });
          socket.once("unexpected-response", (_request, response) => {
            response.resume();
            socket.terminate();
            resolve(response.statusCode ?? 0);
          });
          socket.once("error", reject);
          socket.once("open", () => reject(new Error("Unexpected accepted socket")));
        });
      yield* Effect.promise(async () => {
        const application = await get(app + "/");
        expect(application).toMatchObject({ status: 200, body: "browser application" });
        expect(application.csp).toContain(`frame-src 'self' blob: ${editor};`);
        expect(await get(app + prefix)).toMatchObject({ status: 404 });
        expect(await get(editor + prefix)).toMatchObject({ status: 200, body: "editor:/" });
        for (const route of [
          "/",
          "/rpc",
          "/assets/app.js",
          "/preview/test/",
          "/widget-assets/document/test",
        ])
          expect((await get(editor + route)).status, route).toBe(403);
        expect((await get(editor + prefix, { origin: app })).status).toBe(403);
        expect((await get(editor + prefix, { host: `127.0.0.1:${appPort}` })).status).toBe(403);
        expect((await get(app + "/", { origin: editor })).status).toBe(403);
        expect(await raw(`Host: 127.0.0.1:${editorPort}\r\nHost: evil.example`)).toContain("403");
        expect(
          await raw(`Host: 127.0.0.1:${editorPort}\r\nOrigin: ${editor}\r\nOrigin: ${editor}`),
        ).toContain("403");
        expect(await deniedSocket(editor.replace("http:", "ws:") + "/rpc", editor)).toBe(404);
        expect(await deniedSocket(editor.replace("http:", "ws:") + prefix, app)).toBe(403);
        expect(
          await deniedSocket(editor.replace("http:", "ws:") + prefix, "http://evil.example"),
        ).toBe(403);
        expect(await deniedSocket(app.replace("http:", "ws:") + prefix, app)).toBe(404);
        expect(await deniedSocket(app.replace("http:", "ws:") + "/rpc", editor)).toBe(403);
        const ws = new NodeSocket.NodeWS.WebSocket(editor.replace("http:", "ws:") + prefix, {
          origin: editor,
        });
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        const echoed = new Promise<string>((resolve) =>
          ws.once("message", (bytes) => resolve(bytes.toString())),
        );
        ws.send("isolated");
        expect(await echoed).toBe("isolated");
        const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
        lease.revocation.abort();
        await closed;
        expect((await get(editor + prefix)).status).toBe(403);
        activeLease = { ...lease, id: "b".repeat(64), revocation: new AbortController() };
        const remaining = new NodeSocket.NodeWS.WebSocket(
          editor.replace("http:", "ws:") + editorLeasePath(activeLease),
          { origin: editor },
        );
        await new Promise<void>((resolve, reject) => {
          remaining.once("open", resolve);
          remaining.once("error", reject);
        });
        const stopped = new Promise<void>((resolve) => remaining.once("close", () => resolve()));
        await Effect.runPromise(listener.close());
        await stopped;
      });
    }).pipe(Effect.scoped),
  );
}, 20_000);

it("keeps an IPv6 editor Host and CSP origin bracketed exactly once", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-editor-ipv6-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() => mkdir(join(root, "assets")));
      yield* Effect.promise(() => writeFile(join(root, "index.html"), "ipv6 application"));
      const upstream = createServer((_req, response) => response.end("leased editor"));
      yield* Effect.promise(
        () => new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              upstream.closeAllConnections();
              upstream.close(() => resolve());
            }),
        ),
      );
      const upstreamAddress = upstream.address();
      if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("No upstream");
      const lease: VsCodeLease = {
        id: "c".repeat(64),
        connectionId: 42,
        workspacePath: "/workspace",
        presentedWorkspacePath: "/workspace",
        url: `http://127.0.0.1:${upstreamAddress.port}/`,
        flavor: "codeserver",
        visible: false,
        revocation: new AbortController(),
      };
      const fixture = yield* makeNetworkTestBackend();
      const backend = Context.add(fixture.context, VsCodeServer, {
        ...Context.get(fixture.context, VsCodeServer),
        leaseFor: (id) => (id === lease.connectionId ? lease : undefined),
      });
      const listener = yield* openNetworkListener(
        { bind: "::1", port: 0, browserAssetsDirectory: root },
        {
          homeDirectory: "/home/test",
          cakeChat: {
            agentDirectory: "/agent",
            location: cakeChatLocations.make({
              homeDirectory: "/home/test",
              sessionDirectory: "/chat",
              resolvedSessionDirectory: "/resolved",
            }),
          },
        },
      ).pipe(Effect.provide(backend));
      if (listener.address._tag !== "TcpAddress" || listener.editorPort === undefined)
        throw new Error("No IPv6 listeners");
      const app = `http://[::1]:${listener.address.port}`;
      const editor = `http://[::1]:${listener.editorPort}`;
      const get = (url: string, headers: Record<string, string> = {}) =>
        new Promise<{ status: number; body: string; csp?: string }>((resolve, reject) => {
          request(url, { headers }, (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk.toString()));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body,
                csp: response.headers["content-security-policy"]?.toString(),
              }),
            );
          })
            .on("error", reject)
            .end();
        });
      yield* Effect.promise(async () => {
        const application = await get(app + "/");
        expect(application.status).toBe(200);
        expect(application.csp).toContain(`frame-src 'self' blob: ${editor};`);
        expect(application.csp).not.toContain("[[::1]]");
        expect(await get(editor + editorLeasePath(lease), { origin: editor })).toMatchObject({
          status: 200,
          body: "leased editor",
        });
        expect((await get(editor + editorLeasePath(lease), { origin: app })).status).toBe(403);
        expect((await get(app + editorLeasePath(lease))).status).toBe(404);
      });
    }).pipe(Effect.scoped),
  );
}, 20_000);
