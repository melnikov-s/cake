import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("streaming work logs keep their DOM and follow their own bottom", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-work-log-streaming-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  let response: ServerResponse | undefined;
  const server = createServer((_request, nextResponse) => {
    if (response) {
      nextResponse.writeHead(200, { "content-type": "text/event-stream" });
      nextResponse.end(
        `data: ${JSON.stringify({ id: "complete", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response = nextResponse;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const sendDelta = (delta: object) => {
    if (!response) throw new Error("No provider request");
    response.write(
      `data: ${JSON.stringify({
        id: "stream-fixture",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`,
    );
  };
  const sendReasoning = (text: string) => sendDelta({ reasoning_content: text });
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(join(project, "fixture.ts"), "old");
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "stream-provider": {
          name: "Stream provider",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Stream fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [],
    }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Model configuration" }).click({ timeout: 20_000 });
    await page.getByLabel("Search presets and models").fill("Stream fixture");
    await page
      .getByRole("button", { name: /Stream fixture/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type("Stream a work log");
    await expect(composer).toHaveValue("Stream a work log");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.keyboard.press("Enter");
    await expect.poll(() => Boolean(response)).toBe(true);
    sendReasoning(
      Array.from({ length: 50 }, (_, index) => `Reasoning line ${index}.\n\n`).join(""),
    );
    const log = page.locator('[data-slot="activity-group"]');
    await expect(log).toContainText("Reasoning");
    await log.locator(":scope > summary").click();
    const content = log.locator('[data-slot="work-log-content"]');
    await expect(content).toBeVisible();
    await content.getByRole("button", { name: "Thinking…", exact: true }).click();
    await expect
      .poll(() => content.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(600);
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);

    // Retain a handle across real Pi streaming deltas: replacement of the
    // scrolling surface resets virtualization and is visible as a flash.
    const originalContent = await content.elementHandle();
    const footer = page
      .locator(".transcript [data-viewport-type] > div")
      .last()
      .locator(":scope > div");
    const originalFooter = await footer.elementHandle();
    if (!originalContent || !originalFooter) throw new Error("Missing work log content or footer");
    for (let index = 0; index < 8; index += 1) {
      sendReasoning(`Streaming marker ${index}.\n\n${"More streamed reasoning.\n\n".repeat(4)}`);
      await expect(content).toContainText(`Streaming marker ${index}`);
      expect(await originalContent.evaluate((element) => element.isConnected)).toBe(true);
      expect(await originalFooter.evaluate((element) => element.isConnected)).toBe(true);
      await expect
        .poll(() =>
          content.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
    }

    // Inner scrolling must not move the outer transcript away from its bottom.
    await content.hover();
    await page.mouse.wheel(0, -300);
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeGreaterThan(100);
    sendReasoning("Appended while reading earlier reasoning.\n\n");
    await page.waitForTimeout(300);
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeGreaterThan(100);
    const transcript = page.locator(".transcript");
    await expect
      .poll(() =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.mouse.wheel(0, 10_000);
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    sendReasoning("Following resumed at the inner bottom.\n\n");
    await expect(content).toContainText("Following resumed");
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    // Stream an edit's partial JSON arguments through Pi, not DOM-only changes.
    sendDelta({
      tool_calls: [
        {
          index: 0,
          id: "stream-edit",
          type: "function",
          function: {
            name: "edit",
            arguments: '{"path":"fixture.ts","edits":[{"oldText":"old","newText":"',
          },
        },
      ],
    });
    const diff = content.getByLabel("Streaming file diff");
    for (let index = 0; index < 4; index += 1) {
      const text = Array.from(
        { length: 30 },
        (_, line) => `export const streamed${index}_${line} = ${line};\n`,
      ).join("");
      sendDelta({
        tool_calls: [{ index: 0, function: { arguments: JSON.stringify(text).slice(1, -1) } }],
      });
      await expect(diff).toContainText(`streamed${index}_29`);
      await expect
        .poll(() =>
          content.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      // Streaming code stays plain until settled, rather than alternating
      // between unhighlighted and asynchronously highlighted text every chunk.
      await page.waitForTimeout(200);
      await expect(diff.locator(".syntax-token")).toHaveCount(0);
      expect(await originalContent.evaluate((element) => element.isConnected)).toBe(true);
    }
    sendDelta({ tool_calls: [{ index: 0, function: { arguments: '"}]}' } }] });
    response?.write(
      `data: ${JSON.stringify({ id: "stream-fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    );
    response?.end();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect.poll(() => diff.locator(".syntax-token").count()).toBeGreaterThan(0);
    await expect
      .poll(() =>
        content.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
  } finally {
    response?.end();
    await application.close();
    server.closeAllConnections();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
