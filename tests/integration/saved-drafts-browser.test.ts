import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { beforeAll, it } from "vitest";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";
import { connectClient } from "./fixtures/network-client";

beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

/** Real shared browser shell; only the external Pi/provider boundary is controlled. */
it("two real browser tabs see shared saved edits and one activation reaches the backend", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const controlled = browserBackendAdapter();
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
      });
      const listener = yield* openNetworkListener(
        { port: 0, allowMissingOrigin: true, browserAssetsDirectory: resolve("out/browser") },
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
      const endpoint = `http://127.0.0.1:${listener.address.port}`;
      const socket = yield* connectClient(
        `ws://127.0.0.1:${listener.address.port}${listener.path}`,
      );
      const record = yield* socket.client["savedDrafts.create"]({
        projectPath: "/project",
        title: "Shared browser Draft",
        text: "Original saved request",
        attachments: [],
        configuration: {
          provider: "test",
          modelId: "controlled",
          thinkingLevel: "off",
          fastMode: false,
        },
      });
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const first = await browser.newPage();
          const second = await browser.newPage();
          first.setDefaultTimeout(10_000);
          second.setDefaultTimeout(10_000);
          for (const page of [first, second]) {
            await page.goto(endpoint);
            const row = page
              .locator(`[data-slot="sidebar"] [data-session-id="${record.sessionId}"]`)
              .first();
            await browserExpect(row).toBeVisible();
            await row.click();
            await browserExpect(
              page.getByText("Original saved request", { exact: true }),
            ).toBeVisible();
          }
          await first.getByText("Original saved request", { exact: true }).hover();
          await first.getByRole("button", { name: "Edit latest prompt" }).click();
          const edit = first.getByLabel("Message", { exact: true });
          await browserExpect(edit).toBeFocused();
          await browserExpect(edit).toHaveValue("Original saved request");
          await edit.fill("Updated in first tab");
          await first.getByRole("button", { name: "Save draft", exact: true }).click();
          await browserExpect(
            second.getByText("Updated in first tab", { exact: true }),
          ).toBeVisible();
          const activate = second.getByRole("button", { name: "Activate draft" });
          await activate.click();
          await browserExpect(first.getByText("Draft", { exact: true })).toHaveCount(0);
          await browserExpect.poll(() => controlled.stats.turns).toBe(1);
          await browserExpect(
            first.getByText("Streaming controlled answer", { exact: true }),
          ).toBeVisible();
          const records = await Effect.runPromise(socket.client["savedDrafts.list"]({}));
          assert.equal(
            records.find((item) => item.sessionId === record.sessionId)?.status,
            "activated",
          );
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 30_000);
