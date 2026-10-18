import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
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

it("compiled standalone host serves the shared browser shell independently of cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "cake-browser-node-"));
  const child = spawn(process.execPath, [resolve("out/server/main.mjs")], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CAKE_HOME: home,
      PI_CODING_AGENT_DIR: join(home, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_BROWSER_ENABLED: "true",
      CAKE_SERVER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url = /Cake browser chat at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)?.[1];
        if (url) resolve(url);
      });
      child.once("exit", () => reject(new Error(output)));
      child.once("error", reject);
    });
    const browser = await chromium.launch({ channel: "chromium-headless-shell" });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(url);
      await browserExpect(page.locator('[data-slot="sidebar"]')).toBeVisible();
      await browserExpect(
        page.getByRole("heading", { name: "What should we build?" }),
      ).toBeVisible();
      expect(await page.locator("script[type=module]").getAttribute("src")).toMatch(/^\/assets\//);
    } finally {
      await browser.close();
    }
    child.kill("SIGTERM");
    expect(await exit).toBe(130);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);

it("retains a lost-receipt draft but blocks resending until browser delivery is acknowledged", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const controlled = browserBackendAdapter("/project", true);
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
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
            }),
          },
        },
      ).pipe(Effect.provideContext(backend.context));
      assert.equal(listener.address._tag, "TcpAddress");
      const url = `http://127.0.0.1:${listener.address.port}`;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const page = await browser.newPage({
            viewport: { width: 390, height: 844 },
            hasTouch: true,
            isMobile: true,
          });
          page.setDefaultTimeout(15_000);
          let dropReceipt = true;
          let promptId: string | undefined;
          await page.routeWebSocket("**/rpc", (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const decoded: unknown = JSON.parse(String(message));
              if (
                decoded &&
                typeof decoded === "object" &&
                "tag" in decoded &&
                decoded.tag === "sessionChats.prompt" &&
                "id" in decoded
              )
                promptId = String(decoded.id);
              server.send(message);
            });
            server.onMessage((message) => {
              const decoded: unknown = JSON.parse(String(message));
              if (
                dropReceipt &&
                decoded &&
                typeof decoded === "object" &&
                "requestId" in decoded &&
                String(decoded.requestId) === promptId &&
                "_tag" in decoded &&
                decoded._tag === "Exit"
              ) {
                dropReceipt = false;
                server.close();
                socket.close();
              } else socket.send(message);
            });
          });
          await page.goto(url);
          await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          await browserExpect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
            "data-session-id",
            controlled.existingId,
          );
          await browserExpect(page.getByText("Controlled model", { exact: true })).toBeVisible();
          const input = page.locator('[data-slot="workspace"] textarea').first();
          await input.fill("Lose this receipt");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await browserExpect(page.getByText("Delivery uncertain", { exact: false })).toBeVisible();
          await browserExpect(input).toHaveValue("Lose this receipt");
          await browserExpect.poll(() => controlled.stats.turns).toBe(1);
          // A live socket and retained draft must not silently become a second prompt.
          await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
          await page.reload();
          await browserExpect(page.getByText("Delivery uncertain", { exact: false })).toBeVisible();
          // Phone page entry starts at Cake Chat with navigation collapsed.
          await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          const restoredInput = page.locator('[data-slot="workspace"] textarea').first();
          await browserExpect(restoredInput).toHaveValue("Lose this receipt");
          controlled.finish(controlled.existingId);
          await browserExpect(page.getByText("Completed answer 1", { exact: true })).toBeVisible();
          const send = page.getByRole("button", { name: "Send", exact: true });
          await browserExpect(send).toBeDisabled();
          const sendBox = await send.boundingBox();
          assert.ok(sendBox);
          expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(844);
          expect(controlled.stats.turns).toBe(1);
          await page.getByRole("button", { name: "I checked the server state" }).click();
          await browserExpect(page.getByText("Delivery uncertain", { exact: false })).toHaveCount(
            0,
          );
          await browserExpect(send).toBeEnabled();
          await send.click();
          await browserExpect.poll(() => controlled.stats.turns).toBe(2);
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);

it("mobile draft checkpoints cannot restore accepted prompts while persistence timers are suspended", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const controlled = browserBackendAdapter("/project", true);
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
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
            }),
          },
        },
      ).pipe(Effect.provideContext(backend.context));
      assert.equal(listener.address._tag, "TcpAddress");
      const url = `http://127.0.0.1:${listener.address.port}`;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const page = await browser.newPage({
            viewport: { width: 390, height: 844 },
            hasTouch: true,
            isMobile: true,
          });
          page.setDefaultTimeout(15_000);
          // A mobile OS can freeze timers and discard a background page without
          // pagehide. Hold only the old persistence debounce, not UI/network work.
          await page.addInitScript(() => {
            const schedule = window.setTimeout.bind(window);
            Object.defineProperty(window, "setTimeout", {
              value: (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
                schedule(handler, delay === 180 ? 2_147_000_000 : delay, ...args),
            });
          });
          let holdReceipt = false;
          let dropReceipt = false;
          let releaseReceipt: (() => void) | undefined;
          let promptId: string | undefined;
          let promptRequests = 0;
          await page.routeWebSocket("**/rpc", (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const decoded = JSON.parse(String(message));
              if (decoded.tag === "sessionChats.prompt") {
                promptId = String(decoded.id);
                promptRequests++;
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const decoded = JSON.parse(String(message));
              if (
                dropReceipt &&
                String(decoded.requestId) === promptId &&
                decoded._tag === "Exit"
              ) {
                dropReceipt = false;
                server.close();
                socket.close();
              } else if (
                holdReceipt &&
                String(decoded.requestId) === promptId &&
                decoded._tag === "Exit"
              ) {
                holdReceipt = false;
                releaseReceipt = () => socket.send(message);
              } else socket.send(message);
            });
          });
          await page.goto(url);
          await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          await browserExpect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
            "data-session-id",
            controlled.existingId,
          );
          const input = page.locator('[data-slot="workspace"] textarea').first();
          const saved = () =>
            page.evaluate(() => sessionStorage.getItem("cake.browser.presentation.v1"));
          const checkpoint = () =>
            page.evaluate(() =>
              window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
            );
          const pasteAttachment = (label: string) =>
            input.evaluate((element, label) => {
              const clipboardData = new DataTransfer();
              clipboardData.setData("text/plain", label + "\n" + "details\n".repeat(50));
              element.dispatchEvent(
                new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
              );
            }, label);
          await input.focus();
          await input.pressSequentially("Accepted plain prompt");
          await browserExpect(input).toBeFocused();
          await browserExpect(input).toHaveValue("Accepted plain prompt");
          await browserExpect(
            page.getByRole("button", { name: "Send", exact: true }),
          ).toBeEnabled();
          await checkpoint();
          expect(await saved()).toContain("Accepted plain prompt");
          await browserExpect(input).toHaveValue("Accepted plain prompt");
          await input.press("Enter");
          await browserExpect(input).toHaveValue("");
          await browserExpect.poll(() => controlled.stats.turns).toBe(1);
          // The pre-send checkpoint must be replaced even with no timer or
          // lifecycle event after admission. A discarded page would restore this.
          await browserExpect.poll(saved).not.toContain("Accepted plain prompt");
          controlled.finish(controlled.existingId);
          await browserExpect(page.getByText("Completed answer 1", { exact: true })).toBeVisible();

          await input.fill("Accepted attachment prompt");
          await pasteAttachment("SUBMITTED_ATTACHMENT");
          await browserExpect(
            page.getByRole("button", { name: /^Remove Pasted text/ }),
          ).toBeVisible();
          await checkpoint();
          expect(await saved()).toContain("SUBMITTED_ATTACHMENT");
          holdReceipt = true;
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await browserExpect.poll(() => Boolean(releaseReceipt)).toBe(true);
          await browserExpect(input).toHaveValue("");
          await browserExpect(
            page.getByRole("button", { name: /^Remove Pasted text/ }),
          ).toHaveCount(0);
          expect(controlled.stats.turns).toBe(2);
          // A new draft belongs to the user, not to the outstanding submission ack.
          await input.fill("Genuinely unsent next draft");
          await pasteAttachment("UNSENT_ATTACHMENT");
          releaseReceipt?.();
          await browserExpect(
            page.getByRole("button", { name: "Send", exact: true }),
          ).toBeEnabled();
          await browserExpect(input).toHaveValue("Genuinely unsent next draft");
          await browserExpect.poll(saved).toContain("Genuinely unsent next draft");
          expect(await saved()).not.toContain("Accepted attachment prompt");
          expect(await saved()).not.toContain("SUBMITTED_ATTACHMENT");
          expect(await saved()).toContain("UNSENT_ATTACHMENT");
          await browserExpect(
            page.getByRole("button", { name: /^Remove Pasted text/ }),
          ).toHaveCount(1);
          expect(promptRequests).toBe(2);

          // Resume the same document, then hydrate a fresh one. Neither may
          // restore submitted input or turn it into another send.
          await page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
          );
          await browserExpect(input).toHaveValue("Genuinely unsent next draft");
          await page.reload();
          await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          await browserExpect(input).toHaveValue("Genuinely unsent next draft");
          await browserExpect(
            page.getByRole("button", { name: /^Remove Pasted text/ }),
          ).toHaveCount(1);
          expect(await saved()).not.toContain("SUBMITTED_ATTACHMENT");
          expect(await saved()).toContain("UNSENT_ATTACHMENT");
          expect(controlled.stats.turns).toBe(2);
          expect(promptRequests).toBe(2);

          // A lost receipt is not confirmed rejection: retain recoverable input
          // and the uncertainty gate, including across entry, without replay.
          controlled.finish(controlled.existingId);
          await browserExpect(page.getByText("Completed answer 2", { exact: true })).toBeVisible();
          dropReceipt = true;
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await browserExpect(page.getByText("Delivery uncertain", { exact: false })).toBeVisible();
          await browserExpect(input).toHaveValue("Genuinely unsent next draft");
          await browserExpect(
            page.getByRole("button", { name: /^Remove Pasted text/ }),
          ).toHaveCount(1);
          expect(await saved()).toContain("UNSENT_ATTACHMENT");
          expect(promptRequests).toBe(3);
          expect(controlled.stats.turns).toBe(3);
          await page.reload();
          await browserExpect(page.getByText("Delivery uncertain", { exact: false })).toBeVisible();
          await page.locator('[data-slot="header-sidebar-toggle"]').first().click();
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          await browserExpect(input).toHaveValue("Genuinely unsent next draft");
          await browserExpect(
            page.getByRole("button", { name: "Send", exact: true }),
          ).toBeDisabled();
          expect(promptRequests).toBe(3);
          expect(controlled.stats.turns).toBe(3);
        } finally {
          controlled.finish(controlled.existingId);
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);

it("real Chromium uses the shared sidebar, project chat and Cake Chat without replay on refresh or reconnect", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const controlled = browserBackendAdapter("/project", true);
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
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
            }),
          },
        },
      ).pipe(Effect.provideContext(backend.context));
      assert.equal(listener.address._tag, "TcpAddress");
      const url = `http://127.0.0.1:${listener.address.port}`;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(15_000);
          page.on("pageerror", (error) => errors.push(error.message));
          let severConnection: (() => void) | undefined;
          let connections = 0;
          await page.routeWebSocket("**/rpc", (socket) => {
            connections += 1;
            const server = socket.connectToServer();
            if (!severConnection)
              severConnection = () => {
                server.close();
                socket.close();
              };
            socket.onMessage((message) => server.send(message));
            server.onMessage((message) => socket.send(message));
          });
          await page.goto(url);
          const row = page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first();
          await browserExpect(row).toBeVisible();
          await row.click();
          // Fine-pointer desktop retains its header and editor/console controls,
          // including at phone and intermediate breakpoint boundaries.
          for (const width of [619, 620, 621, 820, 821, 1000, 1001, 1280, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await browserExpect(page.locator('[data-slot="workspace-header"]')).toHaveCSS(
              "height",
              "52px",
            );
            await browserExpect(
              page.getByRole("button", { name: "Open VS Code", exact: true }),
            ).not.toHaveCSS("display", "none");
            await browserExpect(
              page.getByRole("button", { name: "Terminal", exact: true }),
            ).not.toHaveCSS("display", "none");
          }
          await page.setViewportSize({ width: 1280, height: 900 });
          const input = page.locator('[data-slot="workspace"] textarea').first();
          await browserExpect(input).toBeVisible();
          await input.fill("From the shared browser shell");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await browserExpect(
            page.getByText("Streaming controlled answer", { exact: true }),
          ).toBeVisible();
          expect(controlled.stats.turns).toBe(1);
          severConnection?.();
          await browserExpect.poll(() => connections).toBeGreaterThan(1);
          await browserExpect(
            page.getByRole("button", { name: "Stop", exact: true }),
          ).toBeVisible();
          expect(controlled.stats.turns).toBe(1);
          await page.getByRole("button", { name: "Stop", exact: true }).click();
          await browserExpect(page.getByText("Completed answer 1", { exact: true })).toBeVisible();
          await browserExpect(page.getByText("Completed answer 1", { exact: true })).toBeVisible();
          await browserExpect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
            "data-session-id",
            controlled.existingId,
          );
          await page.reload();
          await browserExpect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
            "data-session-id",
            controlled.existingId,
          );
          await browserExpect(page.getByText("Completed answer 1", { exact: true })).toBeVisible();
          expect(controlled.stats.turns).toBe(1);

          const second = await browser.newPage();
          second.setDefaultTimeout(15_000);
          second.on("pageerror", (error) => errors.push(error.message));
          await second.goto(url);
          await second
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          await browserExpect(
            second.getByText("Completed answer 1", { exact: true }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
          await browserExpect(
            page.getByRole("heading", { name: "What can I help you find or do?" }),
          ).toBeVisible();
          await browserExpect(second.locator('[data-slot="workspace"]')).toHaveAttribute(
            "data-session-id",
            controlled.existingId,
          );
          await page.reload();
          await browserExpect(page.locator('[data-slot="sidebar"]')).toBeVisible();
          await browserExpect(
            page.getByRole("heading", { name: "What can I help you find or do?" }),
          ).toBeVisible();
          expect(controlled.stats.turns).toBe(1);
          expect(errors).toEqual([]);
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
