import assert from "node:assert/strict";
import { resolve, join, dirname } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect as browserExpect } from "@playwright/test";
import { Context, Effect } from "effect";
import { beforeAll, expect, it } from "vitest";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { RendererRequestCoordinator } from "../../src/services/renderer-requests/RendererRequestCoordinator";
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

it("compiled standalone host serves the browser build independently of cwd", async () => {
  const home = await mkdtemp(join(tmpdir(), "cake-browser-node-"));
  const child = spawn(process.execPath, [resolve("out/server/main.mjs")], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CAKE_HOME: home,
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_BROWSER_ENABLED: "true",
      CAKE_SERVER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url = /Cake browser chat at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)?.[1];
        if (url) resolve(url);
      });
      child.once("exit", () => reject(new Error(output)));
      child.once("error", reject);
    });
    const browser = await chromium.launch({ channel: "chromium-headless-shell" });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(url);
      await browserExpect(page.getByText("Connected", { exact: true })).toBeVisible();
      await browserExpect(page.getByLabel("Project", { exact: true })).toBeVisible();
      expect(await page.locator("script[type=module]").getAttribute("src")).toMatch(/^\/assets\//);
    } finally {
      await browser.close();
    }
    child.kill("SIGTERM");
    expect(await exit).toBe(130);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);

it("real browser chat navigates, types, streams, stops, answers and reconnects without mutation replay", async () => {
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
      const url = `http://127.0.0.1:${listener.address.port}`;
      yield* Effect.promise(async () => {
        const browser = await chromium.launch({ channel: "chromium-headless-shell" });
        const errors: string[] = [];
        try {
          const page = await browser.newPage();
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await browserExpect(
            page.getByRole("status", { name: "" }).filter({ hasText: "Connected" }),
          ).toBeVisible();
          await page.getByLabel("Project", { exact: true }).selectOption("/project");
          await page.getByLabel("Session", { exact: true }).selectOption(controlled.existingId);
          const input = page.getByLabel("Message Cake", { exact: true });
          await browserExpect(input).toBeVisible();
          await browserExpect(input).toBeFocused();
          await input.pressSequentially("Typed browser prompt");
          await browserExpect(input).toHaveValue("Typed browser prompt");
          const send = page.getByRole("button", { name: "Send", exact: true });
          await browserExpect(send).toBeEnabled();
          await send.click();
          await browserExpect(
            page.getByText("Streaming controlled answer", { exact: true }),
          ).toBeVisible();
          await browserExpect(page.locator('[data-slot="activity-group"]')).toContainText("read");
          if (process.env.CAKE_BROWSER_CHAT_CAPTURE) {
            const output = resolve(process.env.CAKE_BROWSER_CHAT_CAPTURE);
            await mkdir(dirname(output), { recursive: true });
            await page.screenshot({ path: output, fullPage: true });
          }
          await browserExpect(input).toHaveValue("");
          await browserExpect(
            page.getByRole("button", { name: "Stop", exact: true }),
          ).toBeVisible();
          expect(controlled.stats.turns).toBe(1);
          expect(controlled.stats.acquisitions).toBe(1);
          await page.getByRole("button", { name: "Stop", exact: true }).click();
          await browserExpect(page.getByText("Completed answer 1", { exact: true })).toBeVisible();
          expect(controlled.stats.aborts).toBe(1);

          // Keep the real configuration command pending at the external Pi boundary.
          // Sending now must not race ahead under the previously selected configuration.
          const applying = controlled.pauseNextConfiguration();
          try {
            await page.getByRole("button", { name: "Model configuration", exact: true }).click();
            await page.getByRole("button", { name: "Change model", exact: true }).click();
            await page
              .getByRole("button", { name: "Controlled model controlled", exact: true })
              .click();
            await page.getByRole("button", { name: "Apply", exact: true }).click();
            await applying.entered();
            await input.fill("Wait for selected configuration");
            await browserExpect(send).toBeDisabled();
            expect(controlled.stats.turns).toBe(1);
          } finally {
            applying.release();
          }
          await browserExpect(send).toBeEnabled();
          await input.fill("");
          expect(controlled.configurations).toEqual([
            { provider: "test", modelId: "controlled", thinkingLevel: "off", fastMode: false },
          ]);

          const question = Effect.runPromise(
            Context.get(backend.context, RendererRequestCoordinator).requestUiForConnection(
              1,
              controlled.existingId,
              {
                kind: "select",
                title: "Choose direction",
                message: "Which direction?",
                options: [{ id: "north", label: "North" }],
              },
            ),
          );
          await page
            .getByRole("combobox", { name: "Choose direction", exact: true })
            .selectOption("north");
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          expect(await question).toBe("north");
          const formRequest = Effect.runPromise(
            Context.get(backend.context, RendererRequestCoordinator).requestArtifact(
              controlled.existingId,
              {
                artifact: {
                  protocol: "cake.artifact/v1",
                  id: "browser-form",
                  sessionId: controlled.existingId,
                  revision: 1,
                  kind: "request",
                  payload: {
                    request: {
                      protocol: "cake.request/v1",
                      id: "browser-form",
                      title: "Browser question",
                      responseSchema: { type: "object" },
                      view: {
                        type: "form",
                        fields: [{ id: "answer", label: "Browser answer", type: "text" }],
                      },
                      fallback: { markdown: "Answer the question" },
                    },
                  },
                  fallback: { markdown: "Answer the question" },
                  interaction: { mode: "request", responseSchema: { type: "object" } },
                },
                workspacePath: "/project",
                digest: "a".repeat(64),
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              new AbortController().signal,
            ),
          );
          await page
            .getByRole("textbox", { name: "Browser answer", exact: true })
            .fill("Structured response");
          await page.getByRole("button", { name: "Submit", exact: true }).click();
          expect(await formRequest).toEqual({ answer: "Structured response" });
          const unavailableDraw = await Effect.runPromise(
            Context.get(backend.context, RendererRequestCoordinator).requestDrawControl(
              controlled.existingId,
              { _tag: "Enter" },
              new AbortController().signal,
            ),
          );
          expect(unavailableDraw).toMatchObject({ ok: false, code: "CAPABILITY_UNAVAILABLE" });

          await input.fill("First tab draft");
          const second = await browser.newPage({ viewport: { width: 390, height: 844 } });
          second.setDefaultTimeout(10_000);
          second.on("pageerror", (error) => errors.push(error.message));
          await second.goto(url);
          await second.getByLabel("Project", { exact: true }).selectOption("/project");
          await second.getByLabel("Session", { exact: true }).selectOption(controlled.existingId);
          const secondInput = second.getByLabel("Message Cake", { exact: true });
          await browserExpect(
            second.getByText("Completed answer 1", { exact: true }),
          ).toBeVisible();
          await browserExpect(secondInput).toHaveValue("");
          await secondInput.fill("Second tab draft");
          await browserExpect(input).toHaveValue("First tab draft");
          expect(
            await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await second.close();

          // Test-only wire fault: the real handler accepts a turn, but its receipt is lost.
          // No fake client/Store/domain; reconnect goes through the real HTTP+WS listener.
          await page.close();
          const reconnecting = await browser.newPage();
          reconnecting.setDefaultTimeout(10_000);
          reconnecting.on("pageerror", (error) => errors.push(error.message));
          let loseReceipt = true;
          let offline = false;
          let promptId: string | undefined;
          await reconnecting.routeWebSocket("**/rpc", (socket) => {
            if (offline) {
              socket.close();
              return;
            }
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const decoded: unknown = JSON.parse(String(message));
              if (
                decoded &&
                typeof decoded === "object" &&
                "tag" in decoded &&
                decoded.tag === "sessionChats.prompt" &&
                "id" in decoded
              )
                promptId = String(decoded.id);
              server.send(message);
            });
            server.onMessage((message) => {
              const decoded: unknown = JSON.parse(String(message));
              if (
                loseReceipt &&
                decoded &&
                typeof decoded === "object" &&
                "requestId" in decoded &&
                String(decoded.requestId) === promptId &&
                "_tag" in decoded &&
                decoded._tag === "Exit"
              ) {
                loseReceipt = false;
                offline = true;
                server.close();
                socket.close();
              } else socket.send(message);
            });
          });
          await reconnecting.goto(url);
          await reconnecting.getByLabel("Project", { exact: true }).selectOption("/project");
          await reconnecting
            .getByLabel("Session", { exact: true })
            .selectOption(controlled.existingId);
          const retryInput = reconnecting.getByLabel("Message Cake", { exact: true });
          await retryInput.fill("Lose this receipt");
          await reconnecting.getByRole("button", { name: "Send", exact: true }).click();
          await browserExpect(
            reconnecting.getByText("Disconnected · reconnecting…", { exact: true }),
          ).toBeVisible();
          await browserExpect(reconnecting.getByRole("alert")).toContainText(
            "Delivery is uncertain",
          );
          expect(controlled.stats.turns).toBe(2);
          controlled.finish(controlled.existingId);
          offline = false;
          await browserExpect(
            reconnecting.getByText("Completed answer 2", { exact: true }),
          ).toBeVisible({ timeout: 15000 });
          await browserExpect(retryInput).toHaveValue("Lose this receipt");
          await browserExpect(
            reconnecting.getByRole("button", { name: "Send", exact: true }),
          ).toBeDisabled();
          expect(controlled.stats.turns).toBe(2);
          await reconnecting
            .getByRole("button", { name: "Discard retained draft", exact: true })
            .click();
          await browserExpect(retryInput).toHaveValue("");
          expect(controlled.stats.aborts).toBe(1);
          await reconnecting.getByRole("button", { name: "New chat", exact: true }).click();
          await reconnecting
            .getByRole("button", { name: "Model configuration", exact: true })
            .click();
          await reconnecting
            .getByRole("button", { name: "Controlled model controlled", exact: true })
            .click();
          await reconnecting.getByRole("button", { name: "Apply", exact: true }).click();
          await retryInput.pressSequentially("Start ordinary chat");
          await browserExpect(retryInput).toHaveValue("Start ordinary chat");
          const starting = controlled.pauseNextConfiguration();
          try {
            await reconnecting.getByRole("button", { name: "Send", exact: true }).click();
            await starting.entered();
            await browserExpect(
              reconnecting.getByRole("button", { name: "Model configuration", exact: true }),
            ).toHaveCount(0);
            await browserExpect(retryInput).toHaveValue("Start ordinary chat");
            expect(controlled.stats.turns).toBe(2);
          } finally {
            starting.release();
          }
          await browserExpect(
            reconnecting.getByText("Streaming controlled answer", { exact: true }),
          ).toBeVisible();
          await reconnecting.getByRole("button", { name: "Stop", exact: true }).click();
          await browserExpect(
            reconnecting.getByText("Completed answer 3", { exact: true }),
          ).toBeVisible();
          expect(controlled.stats.turns).toBe(3);
          expect(controlled.configurations).toHaveLength(2);
          expect(controlled.configurations[1]).toEqual({
            provider: "test",
            modelId: "controlled",
            thinkingLevel: "off",
            fastMode: false,
          });
          await browserExpect(
            reconnecting.getByLabel("Session", { exact: true }).locator("option"),
          ).toHaveCount(3);
          await reconnecting.getByRole("button", { name: "New chat", exact: true }).click();
          const unsentId = await reconnecting.getByLabel("Session", { exact: true }).inputValue();
          await retryInput.fill("Retain while navigating");
          await reconnecting
            .getByLabel("Session", { exact: true })
            .selectOption(controlled.existingId);
          await browserExpect(retryInput).toHaveValue("");
          await reconnecting.getByLabel("Session", { exact: true }).selectOption(unsentId);
          await browserExpect(retryInput).toHaveValue("Retain while navigating");
          expect(errors).toEqual([]);
        } finally {
          await browser.close();
        }
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
