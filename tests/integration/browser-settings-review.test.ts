import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { beforeAll, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import type { UiPart } from "../../src/ipc/session-contract";
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

it("projects review-run status, saves a label, and gates browser-only native settings", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      // A status projection fixture, not a discussion-thread fixture: this only qualifies
      // rendering/readback. It does not qualify opening, resolving, or navigating a review.
      const reviewRun: UiPart = {
        id: "review-run-test",
        kind: "review-run",
        operationId: "00000000-0000-4000-8000-000000000099",
        threadIds: ["review-thread-test"],
        commentCount: 1,
        status: "complete",
      };
      const controlled = browserBackendAdapter("/project", false, [reviewRun]);
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
          await page.goto(url);
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          await browserExpect(page.getByText("1 comment replied")).toBeVisible();
          await page.reload();
          await browserExpect(page.getByText("1 comment replied")).toBeVisible();
          await page.getByRole("button", { name: "Open settings", exact: true }).click();
          await browserExpect(
            page.getByRole("heading", { name: "Settings", exact: true }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Session labels" }).click();
          await page.getByRole("button", { name: "Add label" }).click();
          await page.getByRole("textbox", { name: "New label name" }).fill("Browser qualification");
          await page.getByRole("button", { name: "Create", exact: true }).click();
          await browserExpect(page.getByText("Browser qualification")).toBeVisible();
          await page.reload();
          await browserExpect(
            page.getByRole("heading", { name: "Settings", exact: true }),
          ).toBeVisible();
          await page.getByRole("button", { name: "Session labels" }).click();
          await browserExpect(page.getByText("Browser qualification")).toBeVisible();
          await page.getByRole("button", { name: "Network & privacy" }).click();
          await browserExpect(
            page.getByText("Desktop sharing is managed in the Cake desktop app", { exact: false }),
          ).toBeVisible();
          await browserExpect(
            page.getByRole("button", { name: /start sharing|enable sharing/i }),
          ).toHaveCount(0);
          await page.getByRole("button", { name: "Dictation" }).click();
          await browserExpect(
            page.getByText("Native dictation and microphone controls are available only", {
              exact: false,
            }),
          ).toBeVisible();
          await browserExpect(
            page.getByRole("button", { name: "Refresh microphones" }),
          ).toHaveCount(0);
          await browserExpect(
            page.getByRole("button", { name: "Download Parakeet model" }),
          ).toHaveCount(0);
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
