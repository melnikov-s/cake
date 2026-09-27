import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import {
  publishInlineWidget,
  revokeInlineWidget,
} from "../../src/services/widgets/inline-widget-document-registry";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";

beforeAll(async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

it("Chromium renders a published navigable widget and HTML artifact in opaque frames without parent access", async () => {
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
      const origin = `http://127.0.0.1:${listener.address.port}`;
      const compiled = publishInlineWidget(
        yield* Effect.promise(() =>
          compileInlineWidget(
            "html",
            `<h1>Published widget</h1><a href="#visited">Navigate widget</a><script>try { parent.document.body.dataset.widgetEscape = "yes"; } catch (error) { document.body.dataset.parentDenied = error.name; }</script>`,
            "display",
          ),
        ),
      );
      try {
        yield* Effect.promise(async () => {
          const browser = await chromium.launch({ channel: "chromium-headless-shell" });
          try {
            const page = await browser.newPage();
            page.setDefaultTimeout(15_000);
            await page.goto(origin);
            await browserExpect(page.locator('[data-slot="sidebar"]')).toBeVisible();
            // Exercise the published document route within Cake's real app CSP, not a localhost
            // page without its frame policy. These attributes match the shared surface frames.
            await page.evaluate(
              ({ token, origin }) => {
                const widget = document.createElement("iframe");
                widget.title = "Published widget";
                widget.sandbox.add("allow-scripts");
                widget.referrerPolicy = "no-referrer";
                widget.src = `${origin}/widget-assets/document/${token}`;
                document.body.append(widget);
                const html = document.createElement("iframe");
                html.title = "HTML artifact";
                html.sandbox.value = "";
                html.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><h1>HTML artifact</h1><a href="#visited">Navigate HTML</a><script>parent.document.body.dataset.htmlEscape="yes"</script>`;
                document.body.append(html);
              },
              { token: compiled.token, origin },
            );
            const widget = page.frameLocator('iframe[title="Published widget"]');
            await browserExpect(
              widget.getByRole("heading", { name: "Published widget" }),
            ).toBeVisible();
            await browserExpect(widget.locator("body")).toHaveAttribute(
              "data-parent-denied",
              "SecurityError",
            );
            await widget.getByRole("link", { name: "Navigate widget" }).click();
            await browserExpect
              .poll(() => page.frame({ url: /widget-assets\/document/ })?.url())
              .toContain("#visited");
            const html = page.frameLocator('iframe[title="HTML artifact"]');
            await browserExpect(html.getByRole("heading", { name: "HTML artifact" })).toBeVisible();
            await browserExpect(html.getByRole("link", { name: "Navigate HTML" })).toBeVisible();
            expect(page.frames().find((frame) => frame.url() === "about:srcdoc")).toBeDefined();
            expect(
              await page
                .locator("body")
                .evaluate((body) => [body.dataset.widgetEscape, body.dataset.htmlEscape]),
            ).toEqual([undefined, undefined]);
            expect(
              await page.locator('iframe[title="Published widget"]').getAttribute("sandbox"),
            ).toBe("allow-scripts");
            expect(
              await page.locator('iframe[title="HTML artifact"]').getAttribute("sandbox"),
            ).toBe("");
          } finally {
            await browser.close();
          }
        });
      } finally {
        revokeInlineWidget(compiled.token);
      }
    }).pipe(Effect.scoped),
  );
}, 60_000);
