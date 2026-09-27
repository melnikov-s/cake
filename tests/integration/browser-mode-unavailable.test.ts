import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { beforeAll, it } from "vitest";
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

it("keeps desktop-only Browser Mode out of browser chat and Draw controls", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-browser-mode-"))),
        (value) => Effect.promise(() => rm(value, { recursive: true, force: true })),
      );
      const projectPath = join(path, "project");
      yield* Effect.promise(() => mkdir(projectPath));
      const controlled = browserBackendAdapter(projectPath, true);
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
        projectPath,
        drawBoardsRoot: join(path, "boards"),
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
      if (listener.address._tag !== "TcpAddress") throw new Error("Expected TCP listener");
      const address = listener.address;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(15_000);
          await page.goto(`http://127.0.0.1:${address.port}`);
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .last()
            .click();
          await browserExpect(page.getByRole("button", { name: /Browser Mode/ })).toHaveCount(0);
          await browserExpect(
            page.locator('[data-slot="workspace"] textarea').first(),
          ).toBeVisible();
          await page.getByRole("button", { name: "Open Cake Draw" }).click();
          await browserExpect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
          await browserExpect(page.getByRole("button", { name: /Browser Mode/ })).toHaveCount(0);
          await browserExpect(page.getByLabel("Browser viewport")).toHaveCount(0);
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
