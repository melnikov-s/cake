import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("429 polling keeps the stop control available", async () => {
  test.setTimeout(120_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-429-stop-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await mkdir(userData, { recursive: true });
  await mkdir(project, { recursive: true });

  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "429 Too Many Requests" } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  // Staged chats use the provider catalog before a project runtime exists.
  // Configure the unbilled provider at the actual catalog boundary.
  await mkdir(join(cakeHome, "pi"), { recursive: true });
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "rate-limit-provider": {
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
              contextWindow: 4_096,
              maxTokens: 1_024,
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
      theme: "system",
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });

    // Select the fixture model.
    const configuration = page.getByRole("button", { name: "Model configuration" });
    await configuration.click();
    const search = page.getByLabel("Search presets and models");
    // An unconfigured staged chat opens the picker directly; an existing model
    // opens the configuration summary first.
    const changeModel = page.getByRole("button", { name: /Change model/ });
    await expect
      .poll(async () => (await search.isVisible()) || (await changeModel.isVisible()))
      .toBe(true);
    if (await changeModel.isVisible()) await changeModel.click();
    await expect(search).toBeVisible();
    await search.fill("Fixture model");
    await page
      .getByRole("button", { name: /Fixture model/ })
      .first()
      .click();
    // Reasoning is off for the fixture model, so Apply applies immediately.
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByLabel("Search presets and models")).toBeHidden();

    // Submit a prompt; the provider always answers 429.
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.fill("Do the thing");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();

    // Wait for the retry notice.
    await expect(page.getByText(/Next retry in/)).toBeVisible({ timeout: 30_000 });

    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();

    // The restored focus accepts typing, retains the draft, and enables submission.
    await expect(composer).toBeFocused();
    await composer.pressSequentially("follow-up");
    await expect(composer).toHaveValue("follow-up");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(stop).toBeHidden();

    await send.click();
    await expect(composer).toHaveValue("");
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    await composer.click();
    await expect(composer).toBeFocused();
    await composer.press("Escape");
    await expect(page.getByText(/Next retry in/)).toBeHidden({ timeout: 15_000 });
  } finally {
    await application.close();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 90_000);
