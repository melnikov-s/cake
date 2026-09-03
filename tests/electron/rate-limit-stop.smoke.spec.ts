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

  await mkdir(join(project, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(project, ".pi", "extensions", "rate-limit-provider.ts"),
    `export default function (pi) { pi.registerProvider("rate-limit-provider", ${JSON.stringify({
      name: "Rate limit provider",
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
    })}); }\n`,
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
  await writeFile(
    join(userData, "application.json"),
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
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });

  try {
    const page = await application.firstWindow();
    const trust = page.getByRole("button", { name: "Trust and open" });
    await expect(trust).toBeVisible({ timeout: 20_000 });
    await trust.click();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });

    // Select the fixture model.
    const configuration = page.getByRole("button", { name: "Model configuration" });
    await configuration.click();
    await page.getByRole("button", { name: /Change model/ }).click();
    const search = page.getByLabel("Search presets and models");
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
    const composer = page.getByLabel("Message");
    await composer.fill("Do the thing");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();

    // Wait for the retry notice.
    await expect(page.getByText(/Next retry in/)).toBeVisible({ timeout: 30_000 });

    const stop = page.getByRole("button", { name: "Stop" });
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
