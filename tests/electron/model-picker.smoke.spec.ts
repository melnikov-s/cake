import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("deferred model picker opens by keyboard and mouse with catalog, search, presets and retained composer input", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-model-picker-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "model-picker-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project, sessionId }));
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

  // Restore a loaded conversation rather than racing the empty project's
  // staged-session initialization and its deferred composer-focus request.
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "model_change",
        id: "fixture-model",
        parentId: null,
        timestamp,
        provider: "picker-fixture-provider",
        modelId: "fixture-model",
      },
      {
        type: "message",
        id: "fixture-prompt",
        parentId: "fixture-model",
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Model picker fixture ready" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
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
    await expect(
      page.locator(".transcript").getByText("Model picker fixture ready", { exact: true }),
    ).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await expect(composer).toBeFocused();
    // Verify a real draft survives every keyboard/mouse model-picker interaction.
    await composer.pressSequentially("Pending first prompt");
    await expect(composer).toHaveValue("Pending first prompt");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
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

    // A mouse reopen refreshes the catalog; selecting and applying a
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
    await expect(composer).toHaveValue("Pending first prompt");
    await composer.pressSequentially(" retained");
    await expect(composer).toHaveValue("Pending first prompt retained");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
