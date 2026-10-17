import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";

const repository = resolve(import.meta.dirname, "../..");
const codeServerPath = "/opt/homebrew/bin/code-server";

test("Project Chat isolates history and restores its root workspace, while global Cake Chat has Browser", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-project-chat-"));
  const project = join(directory, "zombies");
  const cakeHome = join(directory, "cake");
  const userData = join(directory, "user-data");
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Project preview</title><h1>Project preview</h1>");
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(body);
    const content = `Reply ${requests.length}`;
    const chunk = (delta: object, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await Promise.all([
      mkdir(project),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(join(cakeHome, "pi"), { recursive: true }),
      mkdir(userData),
    ]);
    await writeFile(join(project, "example.ts"), "export const zombies = 7;\n");
    await writeFile(
      join(cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `${origin}/v1`,
            apiKey: "fixture",
            api: "openai-completions",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const presetId = "00000000-0000-4000-8000-000000000001";
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: project, name: "Zombies", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
          trustedProjectPaths: [project],
          ...(existsSync(codeServerPath) ? { vscodeServerPath: codeServerPath } : null),
          modelPresets: [
            {
              id: presetId,
              name: "Fixture",
              provider: "fixture",
              modelId: "fixture",
              thinkingLevel: "off",
              fastMode: false,
            },
          ],
          defaultModelPresetId: presetId,
        },
      }),
    );
    const launch = () =>
      electron.launch({
        args: [repository],
        cwd: repository,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_HOME: cakeHome,
          CAKE_ELECTRON_USER_DATA: userData,
          PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
    app = await launch();
    let page = await app.firstWindow();
    // Exclude inert outgoing transcript clones retained by the fade transition.
    const transcript = () =>
      page.locator(
        '[data-slot="content-transition"] > [data-slot="content-transition-live"] .transcript',
      );
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    let input = page.getByRole("combobox", { name: "Message Cake Chat" });
    await expect(input).toBeVisible();
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("GLOBAL_PRIVATE");
    await expect(input).toHaveValue("GLOBAL_PRIVATE");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(page.getByText("Reply 1", { exact: true })).toBeVisible();
    const projectId = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
    const openProject = () =>
      page
        .locator(
          `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
        )
        .click();
    await openProject();
    input = page.getByRole("combobox", { name: "Message Project Chat" });
    await expect(input).toBeVisible();
    await input.click();
    await expect(input).toBeFocused();
    await input.pressSequentially("PROJECT_PRIVATE");
    await expect(input).toHaveValue("PROJECT_PRIVATE");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(page.getByText("Reply 2", { exact: true })).toBeVisible();
    expect(requests[1]).toContain("PROJECT_PRIVATE");
    expect(requests[1]).not.toContain("GLOBAL_PRIVATE");
    await expect(transcript()).not.toContainText("GLOBAL_PRIVATE");

    const header = page.locator(`[data-slot="project-header"][data-session-id="${projectId}"]`);
    const status = header.locator('[data-slot="project-chat-status"]');
    const actions = header.locator('[data-slot="project-actions"]');
    await input.click();
    await expect(status).toHaveCSS("opacity", "1");
    await expect(actions).toHaveCSS("opacity", "0");
    await header.hover();
    await expect(status).toHaveCSS("opacity", "0");
    await expect(actions).toHaveCSS("opacity", "1");
    await header.getByRole("button", { name: "Sort sessions in zombies", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "By date", exact: true }).click();
    await input.click();
    await expect(status).toHaveCSS("opacity", "1");
    await expect(actions).toHaveCSS("opacity", "0");

    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.getByRole("button", { name: "Hide terminal", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Hide terminal", exact: true }).click();
    await page.getByRole("button", { name: "Open VS Code", exact: true }).click();
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    if (existsSync(codeServerPath))
      await expect
        .poll(
          () =>
            app!.evaluate(({ webContents }) =>
              webContents
                .getAllWebContents()
                .some(
                  (view) => /^http:\/\/127\.0\.0\.1:\d+/.test(view.getURL()) && !view.isLoading(),
                ),
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();

    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await page.getByRole("textbox", { name: "Browser address" }).fill(`${origin}/project`);
    await page.getByRole("textbox", { name: "Browser address" }).press("Enter");
    await expect
      .poll(() =>
        app!.evaluate(
          ({ webContents }, url) =>
            webContents.getAllWebContents().some((view) => view.getURL() === url),
          `${origin}/project`,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    await expect(transcript()).toContainText("GLOBAL_PRIVATE");
    await expect(transcript()).not.toContainText("PROJECT_PRIVATE");
    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Browser address" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open VS Code", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to agent", exact: true }).click();
    await openProject();
    await input.fill("Keep this project draft");
    await expect
      .poll(() => readFile(join(userData, "window-state.json"), "utf8"))
      .toContain("Keep this project draft");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toHaveValue(
      "Keep this project draft",
      { timeout: 20_000 },
    );
    await expect(transcript()).toContainText("PROJECT_PRIVATE");
    await expect(transcript()).not.toContainText("GLOBAL_PRIVATE");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    await app?.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
