import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, get as httpGet } from "node:http";
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

it("embeds only an isolated editor origin, supports editor resources and revokes the lease", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-browser-editor-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const projectPath = join(root, "project");
      yield* Effect.promise(() => mkdir(projectPath));
      yield* Effect.promise(() =>
        writeFile(join(projectPath, "qualification.ts"), "export const initial = 42;\n"),
      );
      let appOrigin = "";
      const upstream = createServer((request, response) => {
        response.setHeader("Content-Type", request.url === "/" ? "text/html" : "text/plain");
        response.end(
          request.url === "/"
            ? `<script>
              const checks = {};
              try { checks.parentDom = !!parent.document.body; } catch { checks.parentDom = false; }
              try { checks.parentStorage = parent.sessionStorage.length; } catch { checks.parentStorage = 'denied'; }
              checks.storage = (() => { sessionStorage.setItem('editor-only', 'yes'); return sessionStorage.getItem('editor-only'); })();
              checks.resource = fetch('static/resource').then(r => r.text());
              checks.rpc = fetch('${appOrigin}/rpc').then(r => r.type).catch(() => 'denied');
              checks.ws = new Promise(resolve => {
                const socket = new WebSocket(location.href.replace(/^http/, 'ws'));
                socket.onopen = () => socket.send('editor-ws');
                socket.onmessage = async event => { resolve(await event.data.text()); socket.close(); };
                socket.onerror = () => resolve('failed');
              });
              Promise.all([checks.resource, checks.rpc, checks.ws]).then(([resource, rpc, ws]) => {
                document.body.dataset.result = JSON.stringify({ parentDom: checks.parentDom, parentStorage: checks.parentStorage, storage: checks.storage, resource, rpc, ws });
              });
              </script><body>Isolated workbench</body>`
            : "editor-resource",
        );
      });
      const upstreamSockets = new NodeSocket.NodeWS.WebSocketServer({ server: upstream });
      upstreamSockets.on("connection", (socket) =>
        socket.on("message", (data) => socket.send(data)),
      );
      yield* Effect.promise(
        () => new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(
          () =>
            new Promise<void>((done) => {
              for (const socket of upstreamSockets.clients) socket.terminate();
              upstreamSockets.close();
              upstream.closeAllConnections();
              upstream.close(() => done());
            }),
        ),
      );
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("Missing upstream address");
      let upstreamUrl = `http://127.0.0.1:${address.port}/`;
      const controlled = browserBackendAdapter(projectPath, true);
      let acquisitions = 0;
      const themes: string[] = [];
      let lease: VsCodeLease | undefined;
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
        projectPath,
        vscode: {
          state: () => Effect.succeed({ status: "ready" }),
          stateChanges: () => Stream.succeed({ status: "ready" }),
          acquire: (connectionId) =>
            Effect.sync(() => {
              acquisitions++;
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
          setTheme: (_connectionId, theme) =>
            Effect.sync(() => {
              themes.push(theme);
            }),
          updateAnnotations: (_connectionId, request) =>
            Effect.succeed({ requestId: request.requestId }),
          updateSelectionHighlights: (_connectionId, request) =>
            Effect.succeed({ requestId: request.requestId }),
        },
      });
      const listener = yield* openNetworkListener(
        { port: 0, browserAssetsDirectory: resolve("out/browser") },
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
      ).pipe(Effect.provideContext(backend.context));
      if (listener.address._tag !== "TcpAddress" || !listener.editorPort)
        throw new Error("Missing isolated listener");
      const app = `http://127.0.0.1:${listener.address.port}`;
      appOrigin = app;
      const editor = `http://127.0.0.1:${listener.editorPort}`;
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ channel: "chromium-headless-shell" })),
        (instance) => Effect.promise(() => instance.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      yield* Effect.promise(async () => {
        const response = await page.goto(app);
        expect(await response?.headerValue("content-security-policy")).toContain(
          `frame-src 'self' blob: ${editor}`,
        );
        await page.evaluate(() => sessionStorage.setItem("app-only", "secret"));
        await page
          .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
          .last()
          .click();
        await page.getByRole("button", { name: "Open VS Code" }).click();
        const frame = page.locator('iframe[title="VS Code workspace"]');
        try {
          await browserExpect(frame).toHaveAttribute("src", new RegExp(`^${editor}/editor/`));
        } catch (error) {
          throw new Error(`${String(error)}\n${await page.locator("body").innerText()}`, {
            cause: error,
          });
        }
        const src = await frame.getAttribute("src");
        assert.ok(src);
        expect((await page.request.get(app + new URL(src).pathname)).status()).toBe(404);
        await browserExpect(frame.contentFrame().locator("body[data-result]")).toBeVisible();
        const result = JSON.parse(
          (await frame.contentFrame().locator("body").getAttribute("data-result"))!,
        );
        expect(result).toMatchObject({
          parentDom: false,
          parentStorage: "denied",
          storage: "yes",
          resource: "editor-resource",
          rpc: "denied",
          ws: "editor-ws",
        });
        expect(await page.evaluate(() => sessionStorage.getItem("editor-only"))).toBeNull();
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "dark";
        });
        await browserExpect.poll(() => themes.at(-1)).toBe("dark");
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "light";
        });
        await browserExpect.poll(() => themes.at(-1)).toBe("light");
        await page.getByRole("button", { name: "Back to agent" }).first().click();
        await browserExpect(frame).toHaveCount(0);
        expect((await page.request.get(src)).status()).toBe(403);
        expect(acquisitions).toBe(1);
        await page.reload();
        await browserExpect(page.locator('iframe[title="VS Code workspace"]')).toHaveCount(0);
        // Qualify the actual installed server, not just the controlled upstream.
        const binary = "/opt/homebrew/bin/code-server";
        if (existsSync(binary)) {
          const probe = createServer();
          await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
          const address = probe.address();
          if (!address || typeof address === "string") throw new Error("No test port");
          const port = address.port;
          await new Promise<void>((done) => probe.close(() => done()));
          const diagnostics: string[] = [];
          page.on("console", (message) => {
            if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
          });
          page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.message}`));
          page.on("response", (response) => {
            if (response.url().includes("/editor/") && response.status() >= 400)
              diagnostics.push(`HTTP ${response.status()}: ${response.url()}`);
          });
          page.on("requestfailed", (request) => {
            if (request.url().includes(`/editor/`))
              diagnostics.push(`request: ${request.url()} ${request.failure()?.errorText}`);
          });
          const server = spawn(
            binary,
            [
              "--auth",
              "none",
              "--bind-addr",
              `127.0.0.1:${port}`,
              "--disable-telemetry",
              projectPath,
            ],
            {
              stdio: "ignore",
              env: { ...process.env, HOME: root },
            },
          );
          try {
            upstreamUrl = `http://127.0.0.1:${port}/`;
            let ready = false;
            for (let attempt = 0; attempt < 60; attempt++) {
              ready = await new Promise<boolean>((done) => {
                httpGet(upstreamUrl, (response) => {
                  response.resume();
                  done(response.statusCode === 200 || response.statusCode === 302);
                }).on("error", () => done(false));
              });
              if (ready) break;
              await new Promise((done) => setTimeout(done, 250));
            }
            if (!ready) throw new Error("Installed code-server never became ready");
            await page
              .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
              .last()
              .click();
            await page.getByRole("button", { name: "Open VS Code" }).click();
            const realFrame = page.locator('iframe[title="VS Code workspace"]');
            await browserExpect(realFrame).toHaveAttribute("src", new RegExp(`^${editor}/editor/`));
            await browserExpect(realFrame.contentFrame().locator(".monaco-workbench")).toBeVisible({
              timeout: 20_000,
            });
            const workbench = realFrame.contentFrame();
            await workbench.locator(".monaco-workbench").click({ position: { x: 150, y: 100 } });
            const trust = workbench.locator(".monaco-dialog-modal-block");
            await browserExpect(trust).toBeVisible({ timeout: 15_000 });
            await trust.getByRole("button", { name: /Yes, I trust the authors/ }).click();
            await browserExpect(trust).toBeHidden();
            await workbench.getByRole("treeitem", { name: "qualification.ts" }).dblclick();
            await browserExpect(workbench.locator(".tab.active")).toContainText(
              "qualification.ts",
              {
                timeout: 20_000,
              },
            );
            await browserExpect(workbench.locator(".view-lines").first()).toContainText("initial");
            if (await trust.isVisible())
              throw new Error(`VS Code dialog remains: ${await trust.innerText()}`);
            await workbench.locator(".view-lines").first().click();
            await page.keyboard.press("ControlOrMeta+End");
            await page.keyboard.type("\nexport const browserEdited = true;\n");
            await page.keyboard.press("ControlOrMeta+s");
            await browserExpect
              .poll(() => readFile(join(projectPath, "qualification.ts"), "utf8"))
              .toContain("browserEdited");
            await workbench.locator("body").evaluate(() => location.reload());
            await browserExpect(workbench.locator(".monaco-workbench")).toBeVisible({
              timeout: 20_000,
            });
            await browserExpect(
              workbench.getByRole("treeitem", { name: "qualification.ts" }),
            ).toBeVisible({ timeout: 20_000 });
            await workbench.getByRole("treeitem", { name: "qualification.ts" }).dblclick();
            await browserExpect(workbench.locator(".view-lines").first()).toContainText(
              "browserEdited",
            );
            // This Homebrew build has no optional VSDA assets; update/check is intentionally
            // excluded from the leased workbench. Keep any new route/CSP/WS error visible.
            const unexpected = diagnostics.filter(
              (entry) =>
                entry.includes("/editor/") &&
                !entry.includes("net::ERR_ABORTED") &&
                !entry.includes("Canceled: Canceled") &&
                !entry.includes("/vsda/rust/web/vsda") &&
                !entry.includes("/update/check"),
            );
            if (unexpected.length)
              throw new Error(`Real code-server diagnostics:\n${unexpected.join("\n")}`);
            const realSrc = await realFrame.getAttribute("src");
            assert.ok(realSrc);
            await page.getByRole("button", { name: "Back to agent" }).first().click();
            await browserExpect(realFrame).toHaveCount(0);
            expect((await page.request.get(realSrc)).status()).toBe(403);
          } finally {
            server.kill();
          }
        }
      });
    }).pipe(Effect.scoped),
  );
}, 90_000);
