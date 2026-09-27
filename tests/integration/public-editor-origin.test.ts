import { NodeSocket } from "@effect/platform-node-shared";
import { Context, Effect, Exit } from "effect";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { EditorBrowserPort } from "../../src/server/EditorBrowserPort";
import { acquire } from "../../src/domain/application/embeddedEditor";
import { editorLeasePath } from "../../src/server/editorProxy";
import { VsCodeServer } from "../../src/services/vscode/VsCodeServer";
import type { VsCodeLease } from "../../src/services/vscode/VsCodeServerRuntime";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

const appOrigin = "https://cake.example";
const editorOrigin = "https://editor.example";
const configuration = {
  homeDirectory: "/home/test",
  cakeChat: {
    agentDirectory: "/agent",
    location: cakeChatLocations.make({
      homeDirectory: "/home/test",
      sessionDirectory: "/chat",
      resolvedSessionDirectory: "/resolved",
    }),
  },
};

it("routes a fixed-port public editor Host and Origin while isolating app RPC and leases", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-public-editor-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() => mkdir(join(root, "assets")));
      yield* Effect.promise(() => writeFile(join(root, "index.html"), "Cake"));
      const upstream = createServer((req, response) => response.end(`editor:${req.url}`));
      const sockets = new NodeSocket.NodeWS.WebSocketServer({ server: upstream });
      sockets.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
      yield* Effect.promise(
        () => new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((done) => {
              for (const socket of sockets.clients) socket.terminate();
              sockets.close();
              upstream.closeAllConnections();
              upstream.close(() => done());
            }),
        ),
      );
      const upstreamAddress = upstream.address();
      if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("No upstream");
      const lease: VsCodeLease = {
        id: "e".repeat(64),
        connectionId: 42,
        workspacePath: "/workspace",
        presentedWorkspacePath: "/workspace",
        url: `http://127.0.0.1:${upstreamAddress.port}/`,
        flavor: "codeserver",
        visible: false,
        revocation: new AbortController(),
      };
      let active = true;
      const fixture = yield* makeNetworkTestBackend();
      const backend = Context.add(fixture.context, VsCodeServer, {
        ...Context.get(fixture.context, VsCodeServer),
        leaseFor: (id) => (id === 42 && active ? lease : undefined),
        acquire: () => Effect.succeed(lease),
      });
      // First acquire an ephemeral port, then exercise the fixed-port configuration on it.
      const editorPort = yield* Effect.promise(
        () =>
          new Promise<number>((done) => {
            const reserve = createServer();
            reserve.listen(0, "127.0.0.1", () => {
              const address = reserve.address();
              if (!address || typeof address === "string") throw new Error("No port");
              reserve.close(() => done(address.port));
            });
          }),
      );
      const collidingAppOrigin = `https://cake.example:${editorPort}`;
      const directEditorOrigin = `http://cake.example:${editorPort}`;
      const options = {
        port: 0,
        browserAssetsDirectory: root,
        allowedHosts: ["cake.example", `cake.example:${editorPort}`],
        allowedOrigins: [appOrigin, collidingAppOrigin, directEditorOrigin],
        editorPort,
        editorPublicOrigin: editorOrigin,
      };
      for (const invalid of [
        { ...options, editorPort: 0 },
        { ...options, editorPublicOrigin: appOrigin },
        { ...options, editorPublicOrigin: "https://cake.example:8443" },
        { ...options, allowedOrigins: [appOrigin, editorOrigin] },
        { ...options, allowedHosts: ["cake.example", "editor.example"] },
        { ...options, browserAssetsDirectory: undefined },
      ])
        expect(
          Exit.isFailure(
            yield* openNetworkListener(invalid, configuration).pipe(
              Effect.provide(backend),
              Effect.exit,
            ),
          ),
        ).toBe(true);
      const listener = yield* openNetworkListener(options, configuration).pipe(
        Effect.provide(backend),
      );
      if (listener.address._tag !== "TcpAddress") throw new Error("No TCP address");
      expect(listener.editorPort).toBe(editorPort);
      const acquired = yield* acquire(42, {
        requestId: crypto.randomUUID(),
        workspacePath: "/workspace",
        theme: "dark",
      }).pipe(
        Effect.provide(
          Context.add(backend, EditorBrowserPort, { port: editorPort, publicOrigin: editorOrigin }),
        ),
      );
      expect(acquired).toMatchObject({
        editorPort,
        editorOrigin,
        endpoint: editorLeasePath(lease),
      });
      const appPort = listener.address.port;
      const path = editorLeasePath(lease);
      const get = (port: number, route: string, host: string, origin?: string) =>
        new Promise<{ status: number; body: string; csp?: string }>((resolve, reject) => {
          request(
            `http://127.0.0.1:${port}${route}`,
            { headers: { host, ...(origin ? { origin } : {}) } },
            (response) => {
              let body = "";
              response.on("data", (chunk) => (body += chunk.toString()));
              response.on("end", () =>
                resolve({
                  status: response.statusCode ?? 0,
                  body,
                  csp: response.headers["content-security-policy"]?.toString(),
                }),
              );
            },
          )
            .on("error", reject)
            .end();
        });
      const raw = (headers: string) =>
        new Promise<string>((resolve, reject) => {
          const socket = connect(editorPort, "127.0.0.1", () =>
            socket.end(`GET ${path} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`),
          );
          let body = "";
          socket.on("data", (chunk) => (body += chunk.toString()));
          socket.on("end", () => resolve(body));
          socket.on("error", reject);
        });
      const deniedSocket = (port: number, route: string, host: string, origin: string) =>
        new Promise<number>((resolve, reject) => {
          const ws = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${port}${route}`, {
            origin,
            headers: { host },
          });
          ws.once("unexpected-response", (_req, response) => {
            response.resume();
            ws.terminate();
            resolve(response.statusCode ?? 0);
          });
          ws.once("open", () => reject(new Error("Unexpected accepted socket")));
          ws.once("error", reject);
        });
      yield* Effect.promise(async () => {
        const app = await get(appPort, "/", "cake.example");
        expect(app).toMatchObject({ status: 200, body: "Cake" });
        expect(app.csp).toContain(`http://cake.example:${editorPort} ${editorOrigin}`);
        expect(await get(appPort, path, "cake.example")).toMatchObject({ status: 404 });
        expect(await get(appPort, "/", "cake.example", editorOrigin)).toMatchObject({
          status: 403,
        });
        expect(
          await get(appPort, "/", `cake.example:${editorPort}`, collidingAppOrigin),
        ).toMatchObject({
          status: 200,
          body: "Cake",
        });
        expect(
          await get(appPort, "/", `cake.example:${editorPort}`, directEditorOrigin),
        ).toMatchObject({ status: 403 });
        expect(await get(editorPort, path, "editor.example", editorOrigin)).toMatchObject({
          status: 200,
          body: "editor:/",
        });
        expect(await get(editorPort, path, "editor.example")).toMatchObject({ status: 200 });
        expect(
          await get(
            editorPort,
            path,
            `cake.example:${editorPort}`,
            `http://cake.example:${editorPort}`,
          ),
        ).toMatchObject({ status: 200 });
        for (const [host, origin] of [
          ["cake.example", editorOrigin],
          ["editor.example", appOrigin],
          ["evil.example", editorOrigin],
          ["editor.example", `http://editor.example`],
        ] as const)
          expect((await get(editorPort, path, host, origin)).status).toBe(403);
        expect(
          await raw(`Host: editor.example\r\nHost: editor.example\r\nOrigin: ${editorOrigin}`),
        ).toContain("403");
        expect(
          await raw(`Host: editor.example\r\nOrigin: ${editorOrigin}\r\nOrigin: ${editorOrigin}`),
        ).toContain("403");
        for (const route of ["/", "/rpc", "/assets/app.js", "/widget-assets/document/abc"])
          expect((await get(editorPort, route, "editor.example", editorOrigin)).status).toBe(403);
        expect(await deniedSocket(appPort, "/rpc", "cake.example", editorOrigin)).toBe(403);
        expect(
          await deniedSocket(appPort, "/rpc", `cake.example:${editorPort}`, directEditorOrigin),
        ).toBe(403);
        const rpc = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${appPort}/rpc`, {
          origin: collidingAppOrigin,
          headers: { host: `cake.example:${editorPort}` },
        });
        await new Promise<void>((done, reject) => {
          rpc.once("open", done);
          rpc.once("error", reject);
        });
        rpc.terminate();
        expect(await deniedSocket(editorPort, path, "editor.example", appOrigin)).toBe(403);
        expect(await deniedSocket(editorPort, path, "cake.example", editorOrigin)).toBe(403);
        const ws = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${editorPort}${path}`, {
          origin: editorOrigin,
          headers: { host: "editor.example" },
        });
        await new Promise<void>((done, reject) => {
          ws.once("open", done);
          ws.once("error", reject);
        });
        const echoed = new Promise<string>((done) =>
          ws.once("message", (data) => done(data.toString())),
        );
        ws.send("public-editor");
        expect(await echoed).toBe("public-editor");
        const closed = new Promise<void>((done) => ws.once("close", () => done()));
        lease.revocation.abort();
        active = false;
        await closed;
        expect((await get(editorPort, path, "editor.example", editorOrigin)).status).toBe(403);
        await Effect.runPromise(listener.close());
      });
    }).pipe(Effect.scoped),
  );
}, 20_000);
