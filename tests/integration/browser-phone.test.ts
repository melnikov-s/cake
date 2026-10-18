import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, devices, expect as browserExpect } from "@playwright/test";
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

it.each([320, 360, 384, 390, 412])(
  "touch browser at %ipx navigates, types and recovers without replay",
  async (width) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const controlled = browserBackendAdapter(
          "/project",
          true,
          Array.from({ length: 24 }, (_, index) => ({
            id: `history-${index}`,
            kind: "text" as const,
            role: "assistant" as const,
            status: "complete" as const,
            text: `Earlier answer ${index}\n\n${"Retained transcript content. ".repeat(20)}`,
          })),
        );
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
              ...devices["Pixel 7"],
              viewport: { width, height: 844 },
            });
            const page = await context.newPage();
            page.setDefaultTimeout(15_000);
            // Recover a read-only false-positive left by the previous client, too.
            await page.addInitScript(() =>
              sessionStorage.setItem("cake.browser.delivery-uncertain.v1", "artifacts.stateRead"),
            );
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            let connections = 0;
            let snapshots = 0;
            let sever: (() => void) | undefined;
            let ignoreProbes = false;
            let unavailable = false;
            let probeReplies = 0;
            const probeIds = new Set<string>();
            await page.routeWebSocket("**/rpc", (socket) => {
              connections++;
              if (unavailable) {
                socket.close();
                return;
              }
              const server = socket.connectToServer();
              sever = () => {
                socket.close();
                server.close();
              };
              socket.onMessage((message) => {
                const request = JSON.parse(String(message));
                if (request.tag === "application.getState") {
                  if (ignoreProbes) return; // Half-open transport: the read never responds.
                  probeIds.add(String(request.id));
                }
                server.send(message);
              });
              server.onMessage((message) => {
                const response = JSON.parse(String(message));
                if (response._tag === "Exit" && probeIds.delete(String(response.requestId)))
                  probeReplies++;
                if (String(message).includes('"streaming"')) snapshots++;
                socket.send(message);
              });
            });
            await page.goto(url);
            await page.locator('[data-slot="header-sidebar-toggle"]').first().tap();
            const sidebar = page.locator('[data-slot="sidebar"]');
            await sidebar.locator(`[data-session-id="${controlled.existingId}"]`).first().tap();
            await browserExpect(sidebar).toHaveCount(0);
            await browserExpect(
              page.locator('[data-slot="workspace"] textarea').first(),
            ).toBeVisible();
            await browserExpect(
              page.getByRole("button", { name: "Open settings", exact: true }),
            ).toHaveCount(0);
            await browserExpect(
              page.getByRole("button", { name: "Open VS Code", exact: true }),
            ).toBeHidden();
            await browserExpect(
              page.getByRole("button", { name: "Terminal", exact: true }),
            ).toBeHidden();
            const toggle = page.locator('[data-slot="header-sidebar-toggle"]').first();
            await browserExpect
              .poll(async () => (await toggle.boundingBox())?.width ?? 0)
              .toBeGreaterThanOrEqual(44);
            await browserExpect
              .poll(async () => (await toggle.boundingBox())?.height ?? 0)
              .toBeGreaterThanOrEqual(44);
            await toggle.tap();
            await browserExpect(sidebar).toBeVisible();
            await browserExpect(
              sidebar.getByRole("button", { name: "Open settings", exact: true }),
            ).toBeVisible();
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
            const longDraft = Array.from(
              { length: 20 },
              (_, index) => `Line ${index}: a retained multiline mobile draft`,
            ).join("\n");
            await input.fill(longDraft);
            // A shorter viewport models keyboard space, not a real OS keyboard.
            for (const viewport of [
              { width, height: 360 },
              { width: 844, height: 390 },
            ]) {
              await page.setViewportSize(viewport);
              await browserExpect(input).toBeFocused();
              await browserExpect(input).toHaveValue(longDraft);
              await browserExpect(
                page.getByRole("button", { name: "Open settings", exact: true }),
              ).toHaveCount(0);
              await browserExpect(
                page.getByRole("button", { name: "Open VS Code", exact: true }),
              ).toBeHidden();
              await browserExpect(
                page.getByRole("button", { name: "Terminal", exact: true }),
              ).toBeHidden();
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
            await page.setViewportSize({ width: 1280, height: 900 });
            await browserExpect(
              page.getByRole("button", { name: "Open VS Code", exact: true }),
            ).toBeVisible();
            await browserExpect(
              page.getByRole("button", { name: "Terminal", exact: true }),
            ).toBeVisible();
            await browserExpect(page.locator('[data-slot="workspace-header"]')).toHaveCSS(
              "height",
              "52px",
            );
            await page.setViewportSize({ width, height: 844 });
            await input.fill("Draft from my phone");
            await input.focus();
            await page.getByRole("button", { name: "Session tree", exact: true }).tap();
            const tree = page.getByRole("complementary", { name: "Session tree", exact: true });
            await browserExpect(tree).toBeVisible();
            await browserExpect(tree).toHaveCSS(
              "background-color",
              await page.locator("body").evaluate(() => {
                const probe = document.createElement("div");
                probe.style.backgroundColor = "var(--card)";
                document.body.append(probe);
                const color = getComputedStyle(probe).backgroundColor;
                probe.remove();
                return color;
              }),
            );
            const treeBounds = await tree.boundingBox();
            expect(treeBounds?.x).toBe(0);
            expect(treeBounds?.width).toBe(width);
            expect(treeBounds?.y).toBe(96);
            expect((treeBounds?.y ?? 0) + (treeBounds?.height ?? 0)).toBeLessThanOrEqual(844);
            await tree.getByRole("button", { name: "Close Session tree" }).tap();
            await page.getByRole("button", { name: "Model configuration", exact: true }).tap();
            const picker = page.getByRole("dialog");
            await browserExpect(picker).toBeVisible();
            const pickerBounds = await picker.boundingBox();
            expect(pickerBounds?.x).toBeGreaterThanOrEqual(0);
            expect((pickerBounds?.x ?? 0) + (pickerBounds?.width ?? 0)).toBeLessThanOrEqual(width);
            await page.keyboard.press("Escape");
            // Synthetic lifecycle signals exercise resume hooks, not actual device lock/suspension.
            await browserExpect.poll(() => snapshots).toBeGreaterThan(0);
            const transcript = page.locator(".transcript").first();
            // Establish a deterministic paused reading position. Native mobile scrolling
            // physics are not under test; transport recovery must retain this DOM/Store.
            await transcript.evaluate((element) => {
              element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
              element.scrollTo({ top: 200, behavior: "instant" });
              element.dispatchEvent(new Event("scroll"));
              element.dispatchEvent(new Event("scrollend"));
            });
            const resumeSignals = ["bfcache", "foreground", "offline", "online"];
            for (const signal of resumeSignals) {
              const before = connections;
              const beforeReplies = probeReplies;
              await page.evaluate((signal) => {
                if (signal === "bfcache") {
                  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
                  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
                } else if (signal === "foreground")
                  document.dispatchEvent(new Event("visibilitychange"));
                else window.dispatchEvent(new Event(signal));
              }, signal);
              await browserExpect.poll(() => probeReplies).toBeGreaterThan(beforeReplies);
              expect(connections).toBe(before); // Healthy resume must not disconnect anything.
              await browserExpect(input).toHaveValue("Draft from my phone");
              await browserExpect(send).toBeEnabled();
            }
            // Repeated real drops automatically restore authoritative snapshots in the
            // same selected pane, retaining the draft and transcript reading position.
            const scrollTop = await transcript.evaluate((element) => element.scrollTop);
            for (let attempt = 0; attempt < 2; attempt++) {
              const before = connections;
              const beforeSnapshots = snapshots;
              sever?.();
              await browserExpect
                .poll(() => connections, { timeout: 15_000 })
                .toBeGreaterThan(before);
              await browserExpect
                .poll(() => snapshots, { timeout: 15_000 })
                .toBeGreaterThan(beforeSnapshots);
              await browserExpect(input).toHaveValue("Draft from my phone");
              await browserExpect(send).toBeEnabled();
              await browserExpect(
                page.getByRole("button", { name: "I checked the server state" }),
              ).toHaveCount(0);
              await browserExpect
                .poll(async () =>
                  Math.abs((await transcript.evaluate((element) => element.scrollTop)) - scrollTop),
                )
                .toBeLessThan(2);
              await browserExpect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
                "data-session-id",
                controlled.existingId,
              );
            }
            // A genuinely half-open connection is replaced after a bounded read-only
            // probe, without replaying a send or remounting navigation/drafts.
            ignoreProbes = true;
            const beforeHalfOpen = connections;
            const beforeHalfOpenSnapshots = snapshots;
            await page.evaluate(() => {
              document.dispatchEvent(new Event("visibilitychange"));
              window.dispatchEvent(new Event("online"));
              window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
            });
            await browserExpect
              .poll(() => connections, { timeout: 15_000 })
              .toBeGreaterThan(beforeHalfOpen);
            ignoreProbes = false;
            await browserExpect
              .poll(() => snapshots, { timeout: 15_000 })
              .toBeGreaterThan(beforeHalfOpenSnapshots);
            await browserExpect(input).toHaveValue("Draft from my phone");
            await browserExpect(send).toBeEnabled();
            await browserExpect(
              page.getByRole("button", { name: "I checked the server state" }),
            ).toHaveCount(0);
            if (width === 390) {
              unavailable = true;
              const beforeFailure = connections;
              sever?.();
              await browserExpect
                .poll(() => connections, { timeout: 15_000 })
                .toBeGreaterThan(beforeFailure + 1);
              await browserExpect(
                page.getByText("Disconnected — reconnecting.", { exact: false }),
              ).toBeVisible();
              await browserExpect(input).toHaveValue("Draft from my phone");
              await browserExpect(send).toBeDisabled();
              await browserExpect(
                page.getByRole("button", { name: "I checked the server state" }),
              ).toHaveCount(0);
              unavailable = false;
              const beforeRecovery = snapshots;
              await browserExpect
                .poll(() => snapshots, { timeout: 15_000 })
                .toBeGreaterThan(beforeRecovery);
              await browserExpect(send).toBeEnabled();
            }
            expect(controlled.stats.turns).toBe(0);
            await send.tap();
            await browserExpect(input).toHaveValue("");
            await browserExpect.poll(() => controlled.stats.turns).toBe(1);
            const before = connections;
            sever?.();
            await browserExpect
              .poll(() => connections, { timeout: 15_000 })
              .toBeGreaterThan(before);
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
            await page.getByRole("button", { name: "Browse context", exact: true }).tap();
            await page.setViewportSize({ width, height: 360 });
            const inspector = page.getByRole("dialog");
            await browserExpect(inspector).toBeVisible();
            const inspectorBounds = await inspector.boundingBox();
            expect(inspectorBounds?.x).toBeGreaterThanOrEqual(0);
            expect(inspectorBounds?.y).toBeGreaterThanOrEqual(0);
            expect((inspectorBounds?.y ?? 0) + (inspectorBounds?.height ?? 0)).toBeLessThanOrEqual(
              360,
            );
            await inspector.getByRole("button", { name: "Close context", exact: true }).tap();
            await page.setViewportSize({ width, height: 844 });
            await page.locator('[data-slot="header-sidebar-toggle"]').first().tap();
            await sidebar.getByRole("button", { name: /^Open settings for / }).tap();
            const projectDialog = page.getByRole("dialog");
            const cancel = projectDialog.getByRole("button", { name: "Cancel", exact: true });
            await cancel.scrollIntoViewIfNeeded();
            const cancelBounds = await cancel.boundingBox();
            expect((cancelBounds?.y ?? 0) + (cancelBounds?.height ?? 0)).toBeLessThanOrEqual(844);
            await cancel.tap();
            await sidebar.getByRole("button", { name: "Open settings", exact: true }).tap();
            await page.getByRole("combobox", { name: "Settings section" }).selectOption("network");
            await browserExpect(
              page.getByRole("heading", { name: "Network & privacy" }),
            ).toBeVisible();
            await browserExpect(
              page
                .getByRole("combobox", { name: "Settings section" })
                .getByRole("option", { name: "VS Code", exact: true }),
            ).toHaveCount(0);
            await page.setViewportSize({ width: 824, height: 384 });
            await browserExpect(
              page.getByRole("combobox", { name: "Settings section" }),
            ).toBeVisible();
            await browserExpect(
              page.getByRole("button", { name: "Terminal", exact: true }),
            ).toBeHidden();
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
