import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Context, Effect, Layer } from "effect";
import { beforeAll, expect, it } from "vitest";
import { decodeArtifactLineageId } from "../../src/domain/artifacts/artifact-lineage";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

it("selects published widget and HTML artifacts through the real library projection in Chromium", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-browser-artifacts-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const storageContext = yield* Layer.build(
        makeArtifactStorageLive(directory).pipe(
          Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
        ),
      );
      const storage = Context.get(storageContext, ArtifactStorage);
      const controlled = browserBackendAdapter();
      const backend = yield* makeNetworkTestBackend({
        adapter: controlled.adapter,
        models: [browserTestModel],
      });
      const date = new Date(0).toISOString();
      const publish = (id: string, snapshot: Parameters<typeof storage.publish>[0]["snapshot"]) =>
        storage.publishWithLink(
          {
            lineageId: decodeArtifactLineageId(id),
            expectedLatestRevision: 0,
            snapshot,
            workingDirectory: "/project",
          },
          {
            lineageId: decodeArtifactLineageId(id),
            target: { type: "session", sessionId: controlled.existingId },
            selection: { mode: "follow-latest" },
            createdAt: date,
          },
        );
      yield* publish("browser-widget", {
        protocol: "cake.artifact/v1",
        id: "browser-widget",
        sessionId: controlled.existingId,
        revision: 1,
        kind: "widget",
        title: "Browser widget fixture",
        payload: {
          language: "html",
          source: `<h1>Projected widget</h1><a href="#visited">Navigate widget</a><script>try { parent.document.body.dataset.widgetEscape = "yes"; } catch (error) { document.body.dataset.parentDenied = error.name; }</script>`,
          brief: "Fixture",
          generationSessionId: "generated",
        },
        fallback: { markdown: "Widget fallback" },
        interaction: { mode: "present" },
      });
      yield* publish("browser-html", {
        protocol: "cake.artifact/v1",
        id: "browser-html",
        sessionId: controlled.existingId,
        revision: 1,
        kind: "html",
        title: "Browser HTML fixture",
        payload: {
          html: `<h1>Projected HTML</h1><script>parent.document.body.dataset.htmlEscape = "yes"</script>`,
        },
        fallback: { markdown: "HTML fallback" },
        interaction: { mode: "present" },
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
      ).pipe(Effect.provideContext(Context.add(backend.context, ArtifactStorage, storage)));
      assert.equal(listener.address._tag, "TcpAddress");
      const port = listener.address.port;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(15_000);
          await page.goto(`http://127.0.0.1:${port}`);
          await page.getByRole("button", { name: "Open Artifact Library" }).click();
          await page.getByRole("button", { name: /Browser widget fixture/ }).click();
          const widget = page.frameLocator('iframe[title="Browser widget fixture"]');
          await browserExpect(
            widget.getByRole("heading", { name: "Projected widget" }),
          ).toBeVisible();
          await browserExpect(widget.locator("body")).toHaveAttribute(
            "data-parent-denied",
            "SecurityError",
          );
          const widgetFrame = page.locator('iframe[title="Browser widget fixture"]');
          expect(await widgetFrame.getAttribute("sandbox")).toBe("allow-scripts");
          expect(await widgetFrame.getAttribute("src")).toMatch(
            new RegExp(`^http://127\\.0\\.0\\.1:${port}/widget-assets/document/[0-9a-f-]{36}$`),
          );
          await widget.getByRole("link", { name: "Navigate widget" }).click();
          await browserExpect
            .poll(() => page.frame({ url: /widget-assets\/document/ })?.url())
            .toContain("#visited");
          await page.getByRole("button", { name: /Browser HTML fixture/ }).click();
          const html = page.frameLocator('iframe[title="Browser HTML fixture"]');
          await browserExpect(html.getByRole("heading", { name: "Projected HTML" })).toBeVisible();
          expect(
            await page.locator('iframe[title="Browser HTML fixture"]').getAttribute("sandbox"),
          ).toBe("");
          expect(
            await page
              .locator("body")
              .evaluate((body) => [body.dataset.widgetEscape, body.dataset.htmlEscape]),
          ).toEqual([undefined, undefined]);
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
