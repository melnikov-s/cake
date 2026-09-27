import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Context, Effect } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { RendererRequestCoordinator } from "../../src/services/renderer-requests/RendererRequestCoordinator";
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

it("browser creates, draws, persists and restores a real board; backend Draw control edits and downloads it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-browser-draw-"))),
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
      const url = `http://127.0.0.1:${listener.address.port}`;
      const coordinator = Context.get(backend.context, RendererRequestCoordinator);
      const control = async (invocation: Parameters<typeof coordinator.requestDrawControl>[1]) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        try {
          return await Effect.runPromise(
            coordinator.requestDrawControl(controlled.existingId, invocation, controller.signal),
          );
        } finally {
          clearTimeout(timeout);
        }
      };
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const context = await browser.newContext({ acceptDownloads: true });
          const page = await context.newPage();
          let firstDrawEvents = 0;
          await page.routeWebSocket("**/rpc", (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => server.send(message));
            server.onMessage((message) => {
              if (String(message).includes("draw-control-requested")) firstDrawEvents++;
              socket.send(message);
            });
          });
          page.setDefaultTimeout(20_000);
          await page.goto(url);
          const rows = page.locator(
            `[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`,
          );
          await rows.last().click();
          await browserExpect(page.getByRole("button", { name: "Open Cake Draw" })).toBeVisible();
          await page.getByRole("button", { name: "Open Cake Draw" }).click();
          const canvas = page.locator(".excalidraw__canvas.interactive");
          await browserExpect(canvas).toBeVisible();
          const box = await canvas.boundingBox();
          assert.ok(box);
          await page.getByRole("radio", { name: "Draw", exact: true }).click({ force: true });
          await page.mouse.move(box.x + 180, box.y + 170);
          await page.mouse.down();
          await page.mouse.move(box.x + 240, box.y + 220, { steps: 8 });
          await page.mouse.up();
          await browserExpect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
          const boardsDirectory = join(path, "boards", "boards");
          await browserExpect
            .poll(async () => {
              const files = await readdir(boardsDirectory).catch(() => []);
              if (files.length !== 1) return 0;
              const document = JSON.parse(await readFile(join(boardsDirectory, files[0]!), "utf8"));
              return document.data.snapshot?.elements.length ?? 0;
            })
            .toBeGreaterThan(0);
          const entered = await control({ _tag: "Enter" });
          expect(entered.ok).toBe(true);
          const nativeRead = await control({ _tag: "Read", scope: "page" });
          if (!nativeRead.ok || nativeRead.kind !== "read")
            throw new Error("The browser-drawn shape could not be read");
          const nativeShape = nativeRead.scene.shapes.find((shape) => shape.type === "freedraw");
          assert.ok(nativeShape?.bounds);
          expect(nativeShape.id).not.toContain("shape:");
          const applied = await control({
            _tag: "Apply",
            operations: [
              {
                type: "create",
                shape: {
                  id: "shape:browser-control",
                  type: "geo",
                  x: 300,
                  y: 230,
                  width: 120,
                  height: 70,
                },
              },
            ],
          });
          expect(applied).toMatchObject({ ok: true, kind: "applied" });
          const read = await control({ _tag: "Read", scope: "page" });
          expect(
            read.ok &&
              read.kind === "read" &&
              read.scene.shapes.some((shape) => shape.id === "shape:browser-control"),
          ).toBe(true);

          // Opening a passive second browser tab must not redirect the agent's Draw requests.
          const second = await context.newPage();
          let secondDrawEvents = 0;
          await second.routeWebSocket("**/rpc", (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => server.send(message));
            server.onMessage((message) => {
              if (String(message).includes("draw-control-requested")) secondDrawEvents++;
              socket.send(message);
            });
          });
          await second.goto(url);
          await second
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .last()
            .click();
          await browserExpect(second.getByRole("button", { name: "Open Cake Draw" })).toBeVisible();
          const beforePassiveRead = firstDrawEvents;
          expect((await control({ _tag: "Read", scope: "page" })).ok).toBe(true);
          expect(firstDrawEvents).toBe(beforePassiveRead + 1);
          expect(secondDrawEvents).toBe(0);
          await second.close();
          const download = page.waitForEvent("download");
          await page.getByRole("button", { name: "Export Cake Draw board" }).click();
          await page.getByRole("menuitem", { name: "Editable Excalidraw" }).click();
          const file = await download;
          expect(file.suggestedFilename()).toMatch(/\.excalidraw$/);
          const exported = JSON.parse(await readFile(await file.path(), "utf8"));
          expect(exported.elements.length).toBeGreaterThan(0);
          await page.reload();
          await browserExpect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
          const restored = await control({ _tag: "Read", scope: "page" });
          if (!restored.ok || restored.kind !== "read")
            throw new Error("The reloaded board could not be read");
          expect(restored.scene.shapes.map((shape) => shape.id)).toContain("shape:browser-control");
          expect(restored.scene.shapes.map((shape) => shape.id)).toContain(nativeShape.id);
          const nativeEdit = await control({
            _tag: "Apply",
            operations: [
              { type: "update", id: nativeShape.id, x: nativeShape.bounds.x + 25 },
              { type: "style", ids: [nativeShape.id], style: { strokeWidth: 4 } },
              // Existing shorthand still resolves to the agent-created shape: ID.
              { type: "update", id: "browser-control", x: 325 },
            ],
          });
          expect(nativeEdit).toMatchObject({ ok: true, kind: "applied" });
          const edited = await control({ _tag: "Read", scope: "page" });
          if (!edited.ok || edited.kind !== "read")
            throw new Error("The edited board could not be read");
          expect(edited.scene.shapes.find((shape) => shape.id === nativeShape.id)).toMatchObject({
            bounds: { x: nativeShape.bounds.x + 25 },
            style: { strokeWidth: 4 },
          });
          expect(
            edited.scene.shapes.find((shape) => shape.id === "shape:browser-control")?.bounds?.x,
          ).toBe(325);
          const removed = await control({
            _tag: "Apply",
            operations: [{ type: "delete", ids: [nativeShape.id] }],
          });
          expect(removed).toMatchObject({
            ok: true,
            kind: "applied",
            receipt: { deletedIds: [nativeShape.id] },
          });
          const afterDelete = await control({ _tag: "Read", scope: "page" });
          expect(
            afterDelete.ok &&
              afterDelete.kind === "read" &&
              afterDelete.scene.shapes.some((shape) => shape.id === nativeShape.id),
          ).toBe(false);
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 90_000);
