import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { cakePortableInstructions } from "../../src/services/pi/runtime/cake-instructions";
import { durableInputText } from "../../src/services/pi-durable/durable-input-presentation";
import { seedPermanentChatHistory } from "./durable-chat-fixture";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("desktop Project Session and Project Chat route through the Antigravity picker and permissions", async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), "cake-antigravity-smoke-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const pi = join(cakeHome, "pi");
  const bin = join(root, "bin");
  const directory = cakeWorkspaceSessionDirectory(project, join(pi, "sessions"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await Promise.all(
      [userData, project, join(cakeHome, "state"), directory, bin].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    const agy = join(bin, "agy");
    await copyFile(join(repositoryRoot, "tests/fixtures/antigravity-acp.mjs"), agy);
    await chmod(agy, 0o755);
    const model = {
      provider: "local-fixture",
      modelId: "fixture-model",
      thinkingLevel: "off",
      fastMode: false,
    };
    const manager = SessionManager.create(project, directory);
    manager.appendSessionInfo("Antigravity fixture");
    manager.appendModelChange(model.provider, model.modelId);
    manager.appendMessage({ role: "user", content: "Pi transcript ready", timestamp: Date.now() });
    const sessionId = manager.getSessionId();
    await seedPermanentChatHistory(
      join(pi, "project-chats", createHash("sha256").update(project).digest("hex")),
      durableInputText("The Project Chat example is an atlas", [], false),
    );
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
        modelPresets: [
          { id: "00000000-0000-4000-8000-000000000001", name: "Fixture preset", ...model },
        ],
      }),
    );
    await writeFile(
      join(pi, "models.json"),
      JSON.stringify({
        providers: {
          [model.provider]: {
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "fixture-key",
            api: "openai-completions",
            models: [
              {
                id: model.modelId,
                name: "Fixture model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32000,
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: pi,
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search sessions" });
    await search.getByRole("combobox").pressSequentially("Antigravity fixture");
    await search.getByRole("option", { name: /Antigravity fixture/ }).click();
    await expect(
      page.locator(".transcript").getByText("Pi transcript ready", { exact: true }),
    ).toBeVisible();
    const picker = page.getByRole("button", { name: "Model configuration" });
    const pickerDialog = page.getByRole("dialog", { name: "Model configuration" });
    const chooseAntigravity = async () => {
      await picker.click();
      const change = pickerDialog.getByRole("button", { name: /Change model/ });
      await expect(
        change.or(pickerDialog.getByRole("button", { name: /Gemini · via Antigravity/ })),
      ).toBeVisible();
      if (await change.isVisible()) await change.click();
      await expect(
        pickerDialog.getByRole("button", { name: /Gemini · via Antigravity/ }),
      ).toBeVisible();
      await pickerDialog.screenshot({ path: info.outputPath("antigravity-picker.png") });
      await pickerDialog.getByRole("button", { name: /Gemini · via Antigravity/ }).click();
    };
    await chooseAntigravity();
    await expect(
      page.getByText(/Cake sends its instructions and this message, not Pi history/),
    ).toBeVisible();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    const send = async (text: string) => {
      await composer.fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    };
    const prompt = page.getByRole("alertdialog", { name: "Antigravity permission" });
    await send("fixture permission to allow");
    await expect(prompt).toContainText("echo fixture-only");
    await expect(prompt.getByRole("combobox")).toHaveValue("");
    await page.screenshot({
      path: info.outputPath("antigravity-permission.png"),
      animations: "disabled",
    });
    await prompt.getByRole("combobox").selectOption({ label: "Allow once" });
    await prompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Allowed fixture reply", { exact: true })).toBeVisible();
    await send("fixture permission to deny");
    await prompt.getByRole("combobox").selectOption({ label: "Deny" });
    await prompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Denied fixture reply", { exact: true })).toBeVisible();
    await send("fixture permission to cancel");
    await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText(/Antigravity turn canceled/)).toBeVisible();

    await send("hold before cancel");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText(/Antigravity turn canceled/)).toHaveCount(2);
    await expect(page.getByText("DO NOT SHOW AFTER CANCEL")).toHaveCount(0);

    await writeFile(join(project, "fixture-auth-required"), "");
    await send("show auth required");
    await expect(page.getByText(/Antigravity sign-in required/)).toBeVisible();
    await page.screenshot({ path: info.outputPath("antigravity-auth.png") });
    await rename(agy, join(bin, "agy-disabled"));
    await send("show missing CLI");
    await expect(page.getByText(/not on Cake’s PATH/)).toBeVisible();
    await picker.click();
    await pickerDialog.getByRole("button", { name: /Return to Pi/ }).click();
    await expect(picker).not.toContainText("Antigravity");

    // Restore the fixture after the missing-CLI assertion.
    await rename(join(bin, "agy-disabled"), agy);
    await rm(join(project, "fixture-auth-required"));
    // Switch to the permanent chat. It opts in separately from the Project Session.
    await page.getByRole("button", { name: "Open Project Chat for project", exact: true }).click();
    await expect(
      page.getByText("The Project Chat example is an atlas", { exact: true }),
    ).toBeVisible();
    await expect(picker).not.toContainText("Antigravity");
    await chooseAntigravity();
    await expect(page.getByText(/sharing its result with Google/)).toBeVisible();
    const projectChat = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    const question = "fixture permission from Project Chat";
    await projectChat.fill(question);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(prompt).toContainText("echo fixture-only");
    await page.screenshot({
      path: info.outputPath("project-chat-antigravity-permission.png"),
      animations: "disabled",
    });
    await prompt.getByRole("combobox").selectOption({ label: "Allow once" });
    await prompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Allowed fixture reply", { exact: true })).toBeVisible();
    await expect(page.getByText(question, { exact: true })).toHaveCount(1);
    await expect(
      page.getByText(/Fresh Antigravity session using Cake’s instructions/),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("project-chat-antigravity-turn.png"),
      animations: "disabled",
    });
    const wire = await readFile(join(project, "fixture-acp-wire.ndjson"), "utf8");
    const lastPrompt = wire
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .findLast((frame) => frame.method === "session/prompt");
    expect(lastPrompt.params.prompt).toEqual([
      {
        type: "text",
        text: expect.stringContaining(
          `Cake instructions:\n${cakePortableInstructions("project-chat")}`,
        ),
      },
      { type: "text", text: expect.stringContaining("The Project Chat example is an atlas") },
      { type: "text", text: question },
    ]);
    expect(JSON.stringify(lastPrompt)).not.toContain("Pi transcript ready");
    expect(lastPrompt.params.prompt[0].text).toContain(
      "For authorized project work, use sessions.create",
    );

    const exportPrompt = page.getByRole("alertdialog", { name: "Cake operation and export" });
    await projectChat.fill(
      'fixture Cake [{"command":"todos.create","input":{"title":"Synthetic ACP to-do","description":"Disposable desktop smoke test"}}]',
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(exportPrompt).toContainText("share its result with Google Antigravity");
    await expect(exportPrompt).toContainText("Synthetic ACP to-do");
    await page.screenshot({
      path: info.outputPath("project-chat-cake-export.png"),
      animations: "disabled",
    });
    await exportPrompt.getByRole("combobox").selectOption({ label: "Allow once" });
    await exportPrompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.locator(".transcript").getByText(/"committed": true/)).toBeVisible();
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(cakeHome, "state", "application.json"), "utf8"),
          ).data?.projects.find((item: { path: string }) => item.path === project)?.todos?.items,
      )
      .toEqual([expect.objectContaining({ title: "Synthetic ACP to-do", revision: 0 })]);
    await picker.click();
    await pickerDialog.getByRole("button", { name: /Return to Pi/ }).click();
    await expect(picker).not.toContainText("Antigravity");
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
