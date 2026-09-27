import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Effect } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { loadExtensionCompanions } from "../../src/services/pi/runtime/extension-companions";
import { makeNetworkTestBackend } from "./fixtures/network-backend";
import { browserBackendAdapter, browserTestModel } from "./fixtures/browser-backend";

beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

it("Chromium imports a published companion in the shared shell and dispatches its declared action through backend projection", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const projectPath = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "cake-companion-project-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      // Compile an actual package manifest and TSX entry through the trusted
      // extension resource loader; only the external Pi runtime is controlled.
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(join(projectPath, "extension.ts"), "export default function extension() {}"),
          writeFile(
            join(projectPath, "package.json"),
            JSON.stringify({
              name: "Counter fixture",
              cake: {
                companions: [
                  {
                    id: "counter",
                    extension: "extension.ts",
                    entry: "companion.tsx",
                    slot: "composer.above",
                    actions: ["increment"],
                  },
                ],
              },
            }),
          ),
          writeFile(
            join(projectPath, "companion.tsx"),
            `import React from "react";
             export default function Companion({ state, dispatch, ui }) {
               return <ui.Button onClick={() => dispatch("increment", 1)}>
                 Companion count: {state.count}
               </ui.Button>;
             }`,
          ),
        ]),
      );
      const loaded = yield* Effect.acquireRelease(
        Effect.promise(() =>
          loadExtensionCompanions({
            getExtensions: () => ({
              extensions: [
                {
                  resolvedPath: join(projectPath, "extension.ts"),
                  sourceInfo: { baseDir: projectPath },
                },
              ],
              errors: [],
              runtime: undefined,
            }),
          } as unknown as ResourceLoader),
        ),
        (value) => Effect.sync(() => value.dispose()),
      );
      expect(loaded.diagnostics).toEqual([]);
      const companion = loaded.companions[0];
      assert.ok(companion);
      const token = companion.moduleUrl.slice("cake-extension://module/".length);
      const controlled = browserBackendAdapter(projectPath, true);
      let dispatches = 0;
      const adapter = {
        ...controlled.adapter,
        createRuntime: (options: Parameters<typeof controlled.adapter.createRuntime>[0]) =>
          controlled.adapter.createRuntime(options).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              snapshot: async () => ({
                ...(await runtime.snapshot()),
                extensionUi: {
                  statuses: [],
                  companions: [{ ...companion, state: { count: dispatches } }],
                },
              }),
              dispatchExtensionCompanionAction: async (
                id: string,
                action: string,
                value: unknown,
              ) => {
                assert.equal(id, "counter");
                assert.equal(action, "increment");
                assert.equal(value, 1);
                dispatches++;
                options.onEvent({
                  type: "extension-ui",
                  sessionId: runtime.sessionId,
                  event: { kind: "companion-state", id, state: { count: dispatches } },
                });
              },
            })),
          ),
      };
      const backend = yield* makeNetworkTestBackend({
        adapter,
        models: [browserTestModel],
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
      const port = listener.address.port;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(15_000);
          const imported: string[] = [];
          page.on("request", (request) => {
            if (request.url().includes("/widget-assets/module/")) imported.push(request.url());
          });
          await page.goto(`http://127.0.0.1:${port}`);
          await page
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          const button = page.getByRole("button", { name: "Companion count: 0" });
          await browserExpect(button).toBeVisible();
          expect(imported).toEqual([`http://127.0.0.1:${port}/widget-assets/module/${token}`]);
          await button.click();
          await browserExpect(
            page.getByRole("button", { name: "Companion count: 1" }),
          ).toBeVisible();
          expect(dispatches).toBe(1);

          // A transient module request failure is cached by the browser ESM
          // loader and React.lazy; retry must create a fresh document realm.
          const retryPage = await browser.newPage();
          retryPage.setDefaultTimeout(15_000);
          let unavailable = true;
          await retryPage.route(`**/widget-assets/module/${token}`, async (route) => {
            if (unavailable) {
              unavailable = false;
              await route.fulfill({ status: 503, body: "Backend temporarily unavailable" });
            } else {
              await route.continue();
            }
          });
          await retryPage.goto(`http://127.0.0.1:${port}`);
          await retryPage
            .locator(`[data-slot="sidebar"] [data-session-id="${controlled.existingId}"]`)
            .first()
            .click();
          const reload = retryPage.getByRole("button", { name: "Reload to retry" });
          await browserExpect(reload).toBeVisible();
          await reload.click();
          await browserExpect(
            retryPage.getByRole("button", { name: "Companion count: 1" }),
          ).toBeVisible();
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
