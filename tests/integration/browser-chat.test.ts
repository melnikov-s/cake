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
      const controlled = browserBackendAdapter();
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
              resolvedSessionDirectory: "/chat-resolved",
            }),
          },
        },
      ).pipe(Effect.provideContext(backend.context));
      assert.equal(listener.address._tag, "TcpAddress");
      const url = `http://127.0.0.1:${listener.address.port}`;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const page = await browser.newPage();
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
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
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
          const restoredInput = page.locator('[data-slot="workspace"] textarea').first();
          await browserExpect(restoredInput).toHaveValue("Lose this receipt");
          controlled.finish(controlled.existingId);
          await browserExpect(page.getByText("Completed answer 1", { exact: true })).toBeVisible();
          const send = page.getByRole("button", { name: "Send", exact: true });
          await browserExpect(send).toBeDisabled();
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

it("real Chromium uses the shared sidebar, project chat and Cake Chat without replay on refresh or reconnect", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const controlled = browserBackendAdapter();
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
              resolvedSessionDirectory: "/chat-resolved",
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
          await page.getByRole("button", { name: "New Cake Chat", exact: true }).first().click();
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
