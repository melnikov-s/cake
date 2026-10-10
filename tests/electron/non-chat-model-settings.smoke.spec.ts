import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/services/storage/application-data";
import { nativeNonChatScript, nonChatProviderSource } from "../fixtures/non-chat-provider";
import { nonChatModelChoiceValue } from "../../src/renderer/lib/non-chat-model-choice";

const repositoryRoot = resolve(import.meta.dirname, "../..");
test("image/classifier preferences and native execution controls persist and reach native codemode", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-non-chat-smoke-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const agentDir = join(cakeHome, "pi");
  const trace = join(root, "calls.jsonl");
  const appDocument = join(cakeHome, "state", "application.json");
  const piDocument = join(agentDir, "settings.json");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(join(agentDir, "extensions"), { recursive: true }),
  ]);
  await writeFile(trace, "");
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ "non-chat-fixture": { type: "api_key", key: "fixture" } }),
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
    appDocument,
    JSON.stringify({
      version: 6,
      data: {
        ...defaultApplicationState(),
        projects: [
          {
            path: project,
            name: "project",
            addedAt: new Date(0).toISOString(),
            lastOpenedAt: new Date(0).toISOString(),
          },
        ],
        trustedProjectPaths: [project],
      },
    }),
  );
  await writeFile(
    piDocument,
    JSON.stringify({
      defaultProvider: "non-chat-fixture",
      defaultModel: "chat",
      defaultTools: ["read", "-bash", "+grep"],
    }),
  );
  await writeFile(join(agentDir, "extensions", "provider.ts"), nonChatProviderSource(trace));
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Images\b/ }).click();
    const images = page.getByRole("combobox", { name: "Preferred image model" });
    await expect(images).toBeEnabled();
    const imageValue = nonChatModelChoiceValue({
      provider: "non-chat-fixture",
      modelId: "image-a",
    });
    await images.selectOption(imageValue);
    await expect(images).toHaveValue(imageValue);
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(appDocument, "utf8")).data.nonChatModelPreferences?.image,
      )
      .toEqual({ provider: "non-chat-fixture", modelId: "image-a" });
    await page.getByRole("button", { name: /^Classifiers\b/ }).click();
    await page
      .getByRole("combobox", { name: "Preferred classifier model" })
      .selectOption(
        nonChatModelChoiceValue({ provider: "non-chat-fixture", modelId: "classifier-a" }),
      );
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(appDocument, "utf8")).data.nonChatModelPreferences?.classifier,
      )
      .toEqual({ provider: "non-chat-fixture", modelId: "classifier-a" });
    await page.getByRole("button", { name: "Execution & resources", exact: true }).click();
    await page.getByRole("switch", { name: "Codemode", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Codemode", exact: true })).toBeChecked();
    await expect
      .poll(async () => JSON.parse(await readFile(piDocument, "utf8")).defaultTools)
      .toEqual(["read", "-bash", "+grep", "+codemode"]);
    await page.getByRole("switch", { name: "Tool search", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Tool search", exact: true })).toBeChecked();
    const budget = page.getByRole("textbox", { name: "Codemode inline budget" });
    await budget.click();
    await expect(budget).toBeFocused();
    await budget.fill("");
    await budget.pressSequentially("0");
    await expect(budget).toHaveValue("0");
    await budget.press("Tab");
    await expect
      .poll(async () => JSON.parse(await readFile(piDocument, "utf8")).codemode?.inlineBudget)
      .toBe(0);
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: /^Images\b/ }).click();
    await expect(page.getByRole("combobox", { name: "Preferred image model" })).toHaveValue(
      imageValue,
    );
    // Opening a project chat after changing startup tools must preserve native execution.
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    // Explicit fixture selection prevents any native fallback from using ambient credentials.
    const configuration = page.getByRole("button", { name: "Model configuration", exact: true });
    await configuration.click();
    await page.getByRole("button", { name: /^Fixture chat\b/ }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(configuration).toContainText("Fixture chat");
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    const prompt = `SCRIPT:${nativeNonChatScript("image")}`;
    await composer.pressSequentially(prompt);
    await expect(composer).toHaveValue(prompt);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => await readFile(trace, "utf8")).toContain('"model":"image-a"');
    await expect(page.getByText(/Native result:/).last()).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
