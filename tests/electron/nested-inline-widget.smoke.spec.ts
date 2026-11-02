import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("codemode widget publications stay interactive inline after creation and transcript reopen", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "cake-nested-inline-widget-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  await findVisualCaptureScenario("inline-artifact")!.seed(paths, "dark");
  const results: string[] = [];
  let requests = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (data: Buffer) => (body += data.toString()));
    request.on("end", () => {
      const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] })
        .messages;
      const result = messages.findLast((message) => message.role === "tool");
      const completed = requests++ > 0;
      if (completed) results.push(JSON.stringify(result?.content));
      const code = `for (const [id, title] of [["nested-one", "Nested widget one"], ["nested-two", "Nested widget two"]]) {
  text(await tools.cake({ command: "widgets.instantiate", input: {
    id, title, reference: "cake://artifact/inline-visual@r1", initialState: {},
    fallback: { markdown: title }
  }}));
}`;
      const delta = completed
        ? { role: "assistant", content: "Nested widgets published." }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "nested-publication",
                type: "function",
                function: { name: "codemode", arguments: JSON.stringify({ code }) },
              },
            ],
          };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [value, finish_reason] of [
        [delta, null],
        [{}, completed ? "stop" : "tool_calls"],
      ])
        response.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`,
        );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing model fixture address");
  await mkdir(join(paths.cakeHome, "pi"), { recursive: true });
  await writeFile(
    join(paths.cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "fixture-provider": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture-model",
              name: "Fixture model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    }),
  );
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(
      page
        .locator('[data-artifact-id="inline-visual"] iframe')
        .first()
        .contentFrame()
        .getByRole("heading", { name: "One artifact, two views" }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Model configuration" }).click();
    const search = page.getByLabel("Search presets and models");
    const change = page.getByRole("button", { name: /Change model/ });
    await expect(search.or(change)).toBeVisible();
    if (await change.isVisible()) await change.click();
    await search.fill("Fixture model");
    await page
      .getByRole("button", { name: /Fixture model/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(search).toBeHidden();
    await expect(page.getByRole("button", { name: "Model configuration" })).toContainText(
      "Fixture model",
    );
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await input.fill("Create two independent widgets inline");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Nested widgets published.", { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("nested-two");
    expect(results[0]).not.toContain("Script failed");
    const inline = () =>
      page
        .locator('[data-slot="artifact-disclosure"]')
        .filter({ has: page.locator('[data-artifact-id="nested-two"]') });
    await expect(inline().locator("iframe")).toHaveCount(1);
    const content = inline().locator("iframe").contentFrame();
    await content.getByRole("button", { name: "Explore detail" }).click();
    await expect(content.getByRole("button", { name: "Hide detail" })).toBeVisible();
    await expect(
      page.locator('[data-slot="artifact-disclosure"] [data-artifact-id="nested-one"] iframe'),
    ).toHaveCount(1);
    await inline().getByRole("button", { name: "View Nested widget two fullscreen" }).click();
    const fullscreen = page.getByRole("dialog", { name: "Nested widget two", exact: true });
    await expect(
      fullscreen.locator("iframe").contentFrame().getByRole("button", { name: "Hide detail" }),
    ).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen Nested widget two" }).click();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      inline().locator("iframe").contentFrame().getByRole("button", { name: "Explore detail" }),
    ).toBeVisible({ timeout: 20_000 });
    await inline()
      .locator("iframe")
      .contentFrame()
      .getByRole("button", { name: "Explore detail" })
      .click();
    await expect(
      inline().locator("iframe").contentFrame().getByRole("button", { name: "Hide detail" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "3 artifacts", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Artifacts", exact: true })
      .getByRole("button", { name: /Nested widget two/ })
      .click();
    const pane = page.getByRole("complementary", { name: "Nested widget two", exact: true });
    await expect(
      pane.locator("iframe").contentFrame().getByRole("button", { name: "Explore detail" }),
    ).toBeVisible();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
