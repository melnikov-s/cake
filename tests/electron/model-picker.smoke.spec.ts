import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("deferred model picker opens by keyboard and mouse with catalog, search, presets and retained composer input", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-model-picker-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ projectPath: project, recentProjectPaths: [project], draft: "" }),
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
      modelPresets: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Fixture preset",
          provider: "picker-fixture-provider",
          modelId: "fixture-model",
          thinkingLevel: "off",
          fastMode: false,
        },
      ],
    }),
  );
  const model = {
    id: "fixture-model",
    name: "Fixture model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 1024,
  };
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "picker-fixture-provider": {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "fixture-key",
          api: "openai-completions",
          models: [model],
        },
        "picker-locked-provider": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          models: [{ ...model, name: "Locked fixture model" }],
        },
      },
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
    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(composer).toBeFocused();
    const configuration = page.getByRole("button", { name: "Model configuration" });
    await configuration.focus();
    await configuration.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Model configuration" });
    await expect(dialog).toBeVisible();
    const search = page.getByLabel("Search presets and models");
    const change = dialog.getByRole("button", { name: /Change model/ });
    await expect(search.or(change)).toBeVisible();
    if (await change.isVisible()) await change.click();
    await expect(search).toBeFocused();
    await search.pressSequentially("Fixture");
    await expect(search).toHaveValue("Fixture");
    await expect(search).toBeFocused();
    await expect(dialog.getByRole("button", { name: /Fixture preset/ })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Fixture model fixture-model", exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Locked fixture model/ })).toHaveCount(0);
    await search.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(configuration).toBeFocused();

    // A mouse reopen refreshes the fallback catalog; selecting and applying a
    // model does not cause another open/load or lose the deferred local choice.
    await configuration.click();
    if (await change.isVisible()) await change.click();
    await search.fill("Fixture model");
    await dialog.getByRole("button", { name: "Fixture model fixture-model", exact: true }).click();
    await dialog.getByRole("button", { name: "High", exact: true }).click();
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(configuration).toContainText("Fixture model");
    await expect(configuration).toContainText("High");

    await configuration.focus();
    await configuration.press("Space");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "High", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await change.click();
    await search.pressSequentially("Fixture preset");
    await expect(search).toHaveValue("Fixture preset");
    await expect(search).toBeFocused();
    await dialog.getByRole("button", { name: /Fixture preset/ }).click();
    await expect(dialog).toBeHidden();
    await expect(configuration).toContainText("Fixture preset");

    await composer.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Pending first prompt");
    await expect(composer).toHaveValue("Pending first prompt");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
