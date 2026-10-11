import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  await promisify(execFile)(process.execPath, ["scripts/build-server.mjs"]);
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

it("browser menu actions and pasted image bytes reach backend staging without a browser path", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const projectPath = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-device-project-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const controlled = browserBackendAdapter(projectPath);
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [{ ...browserTestModel, input: ["text", "image"] }],
        projectPath,
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
          const uploads: string[] = [];
          const prompts: string[] = [];
          await page.routeWebSocket("**/rpc", (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const text = String(message);
              if (text.includes("attachmentUploads.chunk")) uploads.push(text);
              if (text.includes("sessionChats.prompt") || text.includes("projectSessions.start"))
                prompts.push(text);
              server.send(message);
            });
            server.onMessage((message) => socket.send(message));
          });
          await page.addInitScript(() => {
            // An HTTP LAN browser has no secure-context Clipboard API.
            Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
            const read = FileReader.prototype.readAsDataURL;
            FileReader.prototype.readAsDataURL = function (file) {
              setTimeout(() => read.call(this, file), 450);
            };
          });
          await page.goto(url);
          const row = page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .last();
          await browserExpect(row).toBeVisible();
          await row.click({ button: "right" });
          await browserExpect(page.getByRole("dialog", { name: "Session actions" })).toBeVisible();
          const copyId = page.getByRole("button", { name: "Copy Session ID" });
          await browserExpect(copyId).toBeEnabled();
          await copyId.click();
          await browserExpect(page.getByRole("dialog", { name: "Session actions" })).toHaveCount(0);
          await row.click({ button: "right" });
          await page.getByRole("button", { name: "Rename", exact: true }).click();
          await browserExpect(page.getByRole("dialog", { name: "Session actions" })).toHaveCount(0);
          await browserExpect(page.getByRole("textbox", { name: "Session name" })).toBeVisible();
          await page.getByRole("textbox", { name: "Session name" }).press("Escape");
          await row.click();
          const input = page.locator('[data-slot="workspace"] textarea').first();
          const imageData =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XlXcAAAAASUVORK5CYII=";
          await input.evaluate((element, data) => {
            const clipboardData = new DataTransfer();
            clipboardData.items.add(
              new File(
                [Uint8Array.from(atob(data), (character) => character.charCodeAt(0))],
                "small.png",
                { type: "image/png" },
              ),
            );
            element.dispatchEvent(
              new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
            );
          }, imageData);
          await browserExpect(
            page.getByRole("img", { name: "small.png", exact: true }),
          ).toBeVisible();
          await input.fill("Inspect pasted image");
          await page.getByRole("button", { name: "Send", exact: true }).click();
          await browserExpect.poll(() => controlled.stats.turns).toBe(1);
          expect(uploads.join(" ")).toContain(imageData);
          expect(prompts.join(" ")).toContain("cake-upload:");
          expect(prompts.join(" ")).not.toContain("browser-file:");
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
