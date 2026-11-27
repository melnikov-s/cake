import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("the Codex GPT-6.2 Sol preset offers Fast mode without enabling it by default", async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "cake-fast-mode-picker-"));
  const userData = join(root, "user-data");
  const cakeHome = join(root, "cake-home");
  const piHome = join(cakeHome, "pi");
  const state = join(cakeHome, "state");
  try {
    await Promise.all([userData, piHome, state].map((path) => mkdir(path, { recursive: true })));
    await writeFile(
      join(state, "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        modelPresets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Sol",
            provider: "openai-codex",
            modelId: "gpt-6.2-sol",
            thinkingLevel: "high",
            fastMode: false,
          },
        ],
      }),
    );
    await writeFile(
      join(piHome, "models.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            baseUrl: "http://127.0.0.1:1",
            apiKey: "fixture-key",
            api: "openai-codex-responses",
            models: [
              {
                id: "gpt-6.2-sol",
                name: "GPT-6.2 Sol",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8192,
              },
            ],
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
        PI_CODING_AGENT_DIR: piHome,
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const configuration = page.getByRole("button", { name: "Model configuration", exact: true });
      await configuration.click();
      const dialog = page.getByRole("dialog", { name: "Model configuration", exact: true });
      const search = dialog.getByRole("textbox", { name: "Search presets and models" });
      const change = dialog.getByRole("button", { name: "Change model" });
      await expect(search.or(change)).toBeVisible();
      if (await change.isVisible()) await change.click();
      await search.fill("gpt-6.2-sol");
      await dialog.getByRole("button", { name: /Sol.*openai-codex\/gpt-6\.2-sol/ }).click();
      await expect(dialog).toBeHidden();
      await expect(configuration).toContainText("Sol");
      await configuration.click();
      const fast = dialog.getByRole("switch", { name: "Fast mode" });
      await expect(fast).toHaveAttribute("aria-checked", "false");
      await fast.click();
      await expect(fast).toHaveAttribute("aria-checked", "true");
      await dialog.screenshot({ path: testInfo.outputPath("codex-sol-fast.png") });
    } finally {
      await application.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
