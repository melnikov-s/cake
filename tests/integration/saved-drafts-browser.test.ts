import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { it } from "vitest";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";
import { connectClient } from "./fixtures/network-client";

/** Run after pnpm build:server and pnpm build:browser; only Pi/provider is controlled. */
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
            await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
            await page.getByLabel("Project", { exact: true }).selectOption("/project");
            await browserExpect(
              page
                .getByLabel("Session", { exact: true })
                .locator(`option[value="${record.sessionId}"]`),
            ).toBeAttached();
            await page.getByLabel("Session", { exact: true }).selectOption(record.sessionId);
          }
          const edit = first.getByLabel("Saved Draft prompt");
          await browserExpect(edit).toHaveValue("Original saved request");
          await edit.fill("Updated in first tab");
          await first.getByRole("button", { name: "Save Draft" }).click();
          await browserExpect(second.getByLabel("Saved Draft prompt")).toHaveValue(
            "Updated in first tab",
          );
          await browserExpect(
            second.getByText("Updated in first tab", { exact: true }),
          ).toBeVisible();
          const activate = second.getByRole("button", { name: "Activate draft" });
          await activate.click();
          await browserExpect(
            first
              .getByLabel("Session", { exact: true })
              .locator(`option[value="${record.sessionId}"]`),
          ).not.toContainText("saved Draft");
          assert.equal(controlled.stats.turns, 1);
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
