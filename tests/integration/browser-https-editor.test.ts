import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  createServer as createHttpServer,
  get as httpGet,
  request as httpRequest,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { NodeSocket } from "@effect/platform-node-shared";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect, Stream } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import type { VsCodeLease } from "../../src/services/vscode/VsCodeServerRuntime";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";

beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build-server.mjs"]);
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

async function freeLocalPort() {
  const probe = createHttpServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  if (!address || !(address instanceof Object)) throw new Error("No local port");
  await new Promise<void>((done) => probe.close(() => done()));
  return address.port;
}

/** One TLS socket, two virtual hosts, with no routing by path or Origin rewriting. */
async function localHttpsProxy() {
  const [key, cert] = await Promise.all([
    readFile(join(import.meta.dirname, "fixtures/preview-localhost.key")),
    readFile(join(import.meta.dirname, "fixtures/preview-localhost.crt")),
  ]);
  let appPort = 0;
  let editorPort = 0;
  let proxyPort = 0;
  const target = (host: string | undefined) => {
    if (host === `127.0.0.1:${proxyPort}`) return appPort;
    if (host === `localhost:${proxyPort}`) return editorPort;
    return undefined;
  };
  const proxy = createHttpsServer({ key, cert }, (incoming, outgoing) => {
    const port = target(incoming.headers.host);
    if (!port) {
      outgoing.writeHead(403).end();
      return;
    }
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  const tunnels = new Set<ReturnType<typeof connect>>();
  proxy.on("upgrade", (incoming, socket, head) => {
    const port = target(incoming.headers.host);
    if (!port) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(port, "127.0.0.1");
    socket.on("error", () => upstream.destroy());
    tunnels.add(upstream);
    upstream.once("connect", () => {
      // rawHeaders retains exactly the browser's Host and Origin; the proxy changes neither.
      upstream.write(
        `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${incoming.rawHeaders.map((value, index) => `${value}${index % 2 ? "\r\n" : ": "}`).join("")}\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => tunnels.delete(upstream));
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address();
  if (!address || !(address instanceof Object)) throw new Error("No TLS proxy port");
  proxyPort = address.port;
  return {
    app: `https://127.0.0.1:${proxyPort}`,
    editor: `https://localhost:${proxyPort}`,
    route: (app: number, editor: number) => {
      appPort = app;
      editorPort = editor;
    },
    close: async () => {
      for (const tunnel of tunnels) tunnel.destroy();
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy.close(() => done()));
    },
  };
}

it("routes a secure Cake app and leased editor via separate origins on one port without sharing RPC authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-https-editor-"));
  const proxy = await localHttpsProxy();
  const browser = await chromium.launch({ channel: "chromium-headless-shell" });
  const upstream = createHttpServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/" ? "text/html" : "text/plain");
    response.end(
      request.url === "/"
        ? `<script>
      let parentAccess; try { parentAccess = !!parent.document.body; } catch { parentAccess = false; }
      let parentStorage; try { parentStorage = parent.sessionStorage.getItem('app-only'); } catch { parentStorage = 'denied'; }
      const resource = fetch('static/resource').then(r => r.text());
      const ws = new Promise(resolve => { const socket = new WebSocket(location.href.replace(/^http/, 'ws')); socket.onopen = () => socket.send('secure-editor'); socket.onmessage = async event => { resolve(typeof event.data === 'string' ? event.data : await event.data.text()); socket.close(); }; socket.onerror = () => resolve('failed'); });
      Promise.all([resource, ws]).then(([text, message]) => document.body.dataset.result = JSON.stringify({ parentAccess, parentStorage, resource: text, ws: message }));
    </script><body>Isolated editor</body>`
        : "editor-resource",
    );
  });
  const sockets = new NodeSocket.NodeWS.WebSocketServer({ server: upstream });
  sockets.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  try {
    await mkdir(join(root, "project"));
    await writeFile(join(root, "project", "qualification.ts"), "export const original = 42;\n");
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const address = upstream.address();
    if (!address || !(address instanceof Object)) throw new Error("No editor upstream");
    let upstreamUrl = `http://127.0.0.1:${address.port}/`;
    const projectPath = join(root, "project");
    const controlled = browserBackendAdapter(projectPath, true, [
      {
        id: "source-link",
        kind: "text",
        role: "assistant",
        status: "complete",
        text: "Open [qualification.ts](qualification.ts#L1).",
      },
    ]);
    const reveals: string[] = [];
    let lease: VsCodeLease | undefined;
    const editorPort = await freeLocalPort();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* makeNetworkTestBackend({
          adapter: controlled.adapter,
          models: [browserTestModel],
          projectPath,
          vscode: {
            state: () => Effect.succeed({ status: "ready" }),
            stateChanges: () => Stream.succeed({ status: "ready" }),
            acquire: (connectionId) =>
              Effect.sync(() => {
                lease = {
                  id: "a".repeat(64),
                  connectionId,
                  workspacePath: projectPath,
                  presentedWorkspacePath: projectPath,
                  url: upstreamUrl,
                  flavor: "codeserver",
                  visible: false,
                  revocation: new AbortController(),
                };
                return lease;
              }),
            leaseFor: (id) =>
              lease?.connectionId === id && !lease.revocation.signal.aborted ? lease : undefined,
            releaseLease: () => Effect.sync(() => lease?.revocation.abort()),
            setTheme: () => Effect.void,
            reveal: (_connectionId, request) =>
              Effect.sync(() => {
                reveals.push(`${request.location.path}:${request.location.range?.start.line}`);
                return {
                  requestId: request.requestId,
                  reveal: { outcome: { view: "file" as const }, locations: [] },
                };
              }),
            updateAnnotations: (_id, request) => Effect.succeed({ requestId: request.requestId }),
            updateSelectionHighlights: (_id, request) =>
              Effect.succeed({ requestId: request.requestId }),
          },
        });
        // The editor Origin must never be promoted to an application RPC origin,
        // even when an operator puts it in the application's origin allowlist.
        const unsafeConfiguration = yield* openNetworkListener(
          {
            port: 0,
            editorPort,
            editorPublicOrigin: proxy.editor,
            browserAssetsDirectory: resolve("out/browser"),
            allowedHosts: [new URL(proxy.app).host],
            allowedOrigins: [proxy.app, proxy.editor],
          },
          {
            homeDirectory: root,
            cakeChat: {
              agentDirectory: root,
              location: cakeChatLocations.make({
                homeDirectory: root,
                sessionDirectory: join(root, "sessions"),
                resolvedSessionDirectory: join(root, "resolved"),
              }),
            },
          },
        ).pipe(Effect.provideContext(fixture.context), Effect.result);
        expect(unsafeConfiguration._tag).toBe("Failure");
        const listener = yield* openNetworkListener(
          {
            port: 0,
            editorPort,
            editorPublicOrigin: proxy.editor,
            browserAssetsDirectory: resolve("out/browser"),
            allowedHosts: [new URL(proxy.app).host],
            allowedOrigins: [proxy.app],
          },
          {
            homeDirectory: root,
            cakeChat: {
              agentDirectory: root,
              location: cakeChatLocations.make({
                homeDirectory: root,
                sessionDirectory: join(root, "sessions"),
                resolvedSessionDirectory: join(root, "resolved"),
              }),
            },
          },
        ).pipe(Effect.provideContext(fixture.context));
        if (listener.address._tag !== "TcpAddress" || listener.editorPort !== editorPort)
          throw new Error("No fixed editor listener");
        const appPort = listener.address.port;
        proxy.route(appPort, editorPort);
        yield* Effect.promise(async () => {
          const context = await browser.newContext({ ignoreHTTPSErrors: true });
          const page = await context.newPage();
          page.setDefaultTimeout(15_000);
          try {
            const rpcFrames: string[] = [];
            let editorSockets = 0;
            page.on("websocket", (socket) => {
              if (socket.url().startsWith(`${proxy.editor.replace("https:", "wss:")}/editor/`))
                editorSockets++;
              if (socket.url().endsWith("/rpc"))
                socket.on("framereceived", (frame) => rpcFrames.push(String(frame.payload)));
            });
            const response = await page.goto(proxy.app);
            expect(response?.status()).toBe(200);
            expect(await response?.headerValue("content-security-policy")).toContain(proxy.editor);
            await page.evaluate(() => sessionStorage.setItem("app-only", "secret"));
            const deniedRpc = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${appPort}/rpc`, {
              origin: proxy.editor,
              headers: { host: new URL(proxy.app).host },
            });
            expect(
              await new Promise<number>((done, fail) => {
                deniedRpc.once("unexpected-response", (_request, response) => {
                  response.resume();
                  deniedRpc.terminate();
                  done(response.statusCode ?? 0);
                });
                deniedRpc.once("error", fail);
                deniedRpc.once("open", () => fail(new Error("Editor origin acquired Cake RPC")));
              }),
            ).toBe(403);
            await page
              .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
              .last()
              .click();
            await page.getByRole("button", { name: "Open VS Code" }).click();
            const frame = page.locator('iframe[title="VS Code workspace"]');
            await browserExpect(frame).toHaveAttribute(
              "src",
              new RegExp(`^${proxy.editor}/editor/`),
            );
            const src = await frame.getAttribute("src");
            if (!src) throw new Error("No editor URL");
            expect(new URL(src).origin).toBe(proxy.editor);
            expect((await context.request.get(proxy.app + new URL(src).pathname)).status()).toBe(
              404,
            );
            await browserExpect
              .poll(() =>
                rpcFrames.some((received) => received.includes(`"editorOrigin":"${proxy.editor}"`)),
              )
              .toBe(true);
            await browserExpect(frame.contentFrame().locator("body[data-result]")).toBeVisible();
            expect(
              JSON.parse(
                (await frame.contentFrame().locator("body").getAttribute("data-result")) ?? "null",
              ),
            ).toEqual({
              parentAccess: false,
              parentStorage: "denied",
              resource: "editor-resource",
              ws: "secure-editor",
            });
            expect(await page.evaluate(() => sessionStorage.getItem("editor-only"))).toBeNull();
            await page.getByRole("button", { name: "Back to agent" }).first().click();
            await browserExpect(frame).toHaveCount(0);
            await browserExpect
              .poll(async () => (await context.request.get(src)).status())
              .toBe(403);
            await page.getByTitle(/^Open qualification\.ts.*in VS Code$/).click();
            await browserExpect(frame).toHaveAttribute(
              "src",
              new RegExp(`^${proxy.editor}/editor/`),
            );
            await browserExpect.poll(() => reveals).toContain("qualification.ts:0");
            await page.getByRole("button", { name: "Back to agent" }).first().click();
            await browserExpect(frame).toHaveCount(0);
            if (existsSync("/opt/homebrew/bin/code-server")) {
              const port = await freeLocalPort();
              const server = spawn(
                "/opt/homebrew/bin/code-server",
                [
                  "--auth",
                  "none",
                  "--bind-addr",
                  `127.0.0.1:${port}`,
                  "--disable-telemetry",
                  projectPath,
                ],
                { stdio: "ignore", env: { ...process.env, HOME: root } },
              );
              try {
                upstreamUrl = `http://127.0.0.1:${port}/`;
                await browserExpect
                  .poll(
                    () =>
                      new Promise<boolean>((done) =>
                        httpGet(upstreamUrl, (response) => {
                          response.resume();
                          done(response.statusCode === 200 || response.statusCode === 302);
                        }).on("error", () => done(false)),
                      ),
                    { timeout: 20_000 },
                  )
                  .toBe(true);
                await page
                  .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
                  .last()
                  .click();
                await page.getByRole("button", { name: "Open VS Code" }).click();
                const realFrame = page.locator('iframe[title="VS Code workspace"]');
                await browserExpect(realFrame).toHaveAttribute(
                  "src",
                  new RegExp(`^${proxy.editor}/editor/`),
                );
                const realSrc = await realFrame.getAttribute("src");
                if (!realSrc) throw new Error("No code-server URL");
                const editor = realFrame.contentFrame();
                await browserExpect(editor.locator(".monaco-workbench")).toBeVisible({
                  timeout: 30_000,
                });
                await editor.locator(".monaco-workbench").click({ position: { x: 150, y: 100 } });
                const trust = editor.locator(".monaco-dialog-modal-block");
                await browserExpect(trust).toBeVisible({ timeout: 15_000 });
                await trust.getByRole("button", { name: /Yes, I trust the authors/ }).click();
                await browserExpect(trust).toBeHidden();
                await editor.getByRole("treeitem", { name: "qualification.ts" }).dblclick();
                await browserExpect(editor.locator(".tab.active")).toContainText(
                  "qualification.ts",
                );
                await browserExpect(editor.locator(".view-lines").first()).toContainText(
                  "original",
                );
                await editor.locator(".view-lines").first().click();
                await page.keyboard.press("ControlOrMeta+End");
                await page.keyboard.type("\nexport const secureSaved = true;\n");
                await page.keyboard.press("ControlOrMeta+s");
                await browserExpect
                  .poll(() => readFile(join(projectPath, "qualification.ts"), "utf8"))
                  .toContain("secureSaved");
                await editor.locator("body").evaluate(() => location.reload());
                await browserExpect(editor.locator(".monaco-workbench")).toBeVisible({
                  timeout: 30_000,
                });
                await editor.getByRole("treeitem", { name: "qualification.ts" }).dblclick();
                await browserExpect(editor.locator(".tab.active")).toContainText(
                  "qualification.ts",
                );
                expect(editorSockets).toBeGreaterThanOrEqual(2);
                await page.getByRole("button", { name: "Back to agent" }).first().click();
                await browserExpect
                  .poll(async () => (await context.request.get(realSrc)).status())
                  .toBe(403);
              } finally {
                server.kill();
              }
            }
          } finally {
            await context.close();
          }
        });
      }).pipe(Effect.scoped),
    );
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
    await browser.close();
    await proxy.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
