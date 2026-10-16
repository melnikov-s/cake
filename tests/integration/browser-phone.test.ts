import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";

beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

it.each([320, 390])(
  "touch browser at %ipx navigates, types and recovers without replay",
  async (width) => {
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
            const context = await browser.newContext({
              viewport: { width, height: 844 },
              hasTouch: true,
              isMobile: true,
            });
            const page = await context.newPage();
            page.setDefaultTimeout(15_000);
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            let connections = 0;
            let snapshots = 0;
            let sever: (() => void) | undefined;
            await page.routeWebSocket("**/rpc", (socket) => {
              connections++;
              const server = socket.connectToServer();
              sever = () => {
                socket.close();
                server.close();
              };
              socket.onMessage((message) => server.send(message));
              server.onMessage((message) => {
                if (String(message).includes('"streaming"')) snapshots++;
                socket.send(message);
              });
            });
            await page.goto(url);
            const sidebar = page.locator('[data-slot="sidebar"]');
            await sidebar.locator(`[data-session-id="${controlled.existingId}"]`).first().tap();
            await browserExpect(sidebar).toHaveCount(0);
            const toggle = page.locator('[data-slot="header-sidebar-toggle"]').first();
            const toggleBox = await toggle.boundingBox();
            expect(toggleBox?.width).toBeGreaterThanOrEqual(44);
            expect(toggleBox?.height).toBeGreaterThanOrEqual(44);
            await toggle.tap();
            await browserExpect(sidebar).toBeVisible();
            await page
              .getByRole("button", { name: "Close navigation", exact: true })
              .tap({ position: { x: width - 10, y: 200 } });
            await browserExpect(sidebar).toHaveCount(0);
            const input = page.locator('[data-slot="workspace"] textarea').first();
            const send = page.getByRole("button", { name: "Send", exact: true });
            await input.tap();
            await input.pressSequentially("Draft from my phone");
            await browserExpect(input).toBeFocused();
            await browserExpect(input).toHaveValue("Draft from my phone");
            await browserExpect(send).toBeEnabled();
            expect(await input.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
              "16px",
            );
            // A shorter viewport models keyboard space, not a real OS keyboard.
            for (const viewport of [
              { width, height: 360 },
              { width: 844, height: 390 },
            ]) {
              await page.setViewportSize(viewport);
              await browserExpect(input).toBeFocused();
              await browserExpect
                .poll(async () => {
                  const box = await send.boundingBox();
                  return box ? box.y + box.height : Infinity;
                })
                .toBeLessThanOrEqual(viewport.height);
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= window.innerWidth,
                ),
              ).toBe(true);
            }
            await page.setViewportSize({ width, height: 844 });
            // Synthetic lifecycle signals exercise resume hooks, not actual device lock/suspension.
            await browserExpect.poll(() => snapshots).toBeGreaterThan(0);
            const resumeSignals = ["bfcache", "foreground", "offline", "online"];
            for (const signal of resumeSignals) {
              const before = connections;
              const beforeSnapshots = snapshots;
              await page.evaluate((signal) => {
                if (signal === "bfcache") {
                  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
                  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
                } else if (signal === "foreground")
                  document.dispatchEvent(new Event("visibilitychange"));
                else window.dispatchEvent(new Event(signal));
              }, signal);
              await browserExpect.poll(() => connections).toBeGreaterThan(before);
              await browserExpect.poll(() => snapshots).toBeGreaterThan(beforeSnapshots);
              await browserExpect(input).toHaveValue("Draft from my phone");
              await browserExpect(send).toBeEnabled();
            }
            expect(controlled.stats.turns).toBe(0);
            await send.tap();
            await browserExpect(input).toHaveValue("");
            await browserExpect.poll(() => controlled.stats.turns).toBe(1);
            const before = connections;
            sever?.();
            await browserExpect.poll(() => connections).toBeGreaterThan(before);
            controlled.finish(controlled.existingId);
            await browserExpect(
              page.getByText("Completed answer 1", { exact: true }),
            ).toBeVisible();
            expect(controlled.stats.turns).toBe(1);
            await toggle.tap();
            await sidebar.getByRole("button", { name: "Cake Chat", exact: true }).first().tap();
            await browserExpect(sidebar).toHaveCount(0);
            await browserExpect(
              page.getByRole("heading", { name: "What can I help you find or do?" }),
            ).toBeVisible();
            await page.locator('[data-slot="header-sidebar-toggle"]').first().tap();
            await sidebar.getByRole("button", { name: "Open settings", exact: true }).tap();
            await page.getByRole("combobox", { name: "Settings section" }).selectOption("network");
            await browserExpect(
              page.getByRole("heading", { name: "Network & privacy" }),
            ).toBeVisible();
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            ).toBe(true);
            expect(errors).toEqual([]);
          } finally {
            await browser.close();
          }
        });
      }).pipe(Effect.scoped),
    );
  },
  60_000,
);
