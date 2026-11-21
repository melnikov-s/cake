import { createHash } from "node:crypto";
import { once } from "node:events";
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
import { createSessionInProject } from "./fixtures/workspace-navigation";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("desktop Project Session and Project Chat route through the Antigravity picker and permissions", async ({}, info) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-antigravity-smoke-"));
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const pi = join(cakeHome, "pi");
  const bin = join(root, "bin");
  const directory = cakeWorkspaceSessionDirectory(project, join(pi, "sessions"));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let crashed = false;
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
    await expect(page.getByLabel("Message Cake Chat")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const presets = page.getByRole("region", { name: "Model Presets" });
    const editor = page.getByRole("dialog", { name: "Preset model" });
    await presets.getByRole("button", { name: "New preset", exact: true }).click();
    await presets.getByRole("textbox", { name: "Name", exact: true }).fill("Gemini for chat");
    await presets.getByRole("button", { name: "Preset model" }).click();
    await editor.getByRole("textbox", { name: "Search presets and models" }).fill("antigravity");
    await editor.getByRole("button", { name: /Gemini · via Antigravity/ }).click();
    await editor.getByRole("button", { name: "Apply", exact: true }).click();
    await presets.screenshot({
      path: info.outputPath("antigravity-preset-editor.png"),
      animations: "disabled",
    });
    await presets.getByRole("button", { name: "Save preset", exact: true }).click();
    const preset = presets.locator("article").filter({ hasText: "Gemini for chat" });
    await expect(preset.getByText("Gemini · via Antigravity")).toBeVisible();
    await preset.getByRole("button", { name: "Edit", exact: true }).click();
    await presets.getByRole("textbox", { name: "Name", exact: true }).fill("Gemini saved");
    await presets.getByRole("button", { name: "Save preset", exact: true }).click();
    await presets
      .locator("article")
      .filter({ hasText: "Gemini saved" })
      .getByRole("button", { name: "Set default", exact: true })
      .click();
    await expect
      .poll(async () => {
        const data = JSON.parse(
          await readFile(join(cakeHome, "state", "application.json"), "utf8"),
        ).data;
        return data?.modelPresets.find(
          (item: { id: string }) => item.id === data.defaultModelPresetId,
        );
      })
      .toMatchObject({
        name: "Gemini saved",
        provider: "antigravity",
        modelId: "gemini",
        thinkingLevel: "off",
        fastMode: false,
      });
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();

    const picker = page.getByRole("button", { name: "Model configuration" });
    const pickerDialog = page.getByRole("dialog", { name: "Model configuration" });
    await picker.click();
    await pickerDialog.getByRole("button", { name: /Change model/ }).click();
    await pickerDialog.getByRole("button", { name: /Gemini saved/ }).click();
    await expect(picker).toContainText("Gemini saved");
    await page.getByLabel("Message Cake Chat").fill("First global fixture turn");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("ACP first chunk · café + final chunk", { exact: true }),
    ).toBeVisible();

    await createSessionInProject(page, /^project(?: |$)/i);
    await expect(picker).toContainText("Gemini saved");
    await page
      .getByRole("combobox", { name: "Message", exact: true })
      .fill("First draft fixture turn");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByText("ACP first chunk · café + final chunk", { exact: true }),
    ).toBeVisible();
    expect(await readFile(join(project, "fixture-acp-wire.ndjson"), "utf8")).toContain(
      "First draft fixture turn",
    );
    await page.screenshot({
      path: info.outputPath("antigravity-first-draft-turn.png"),
      animations: "disabled",
    });

    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search sessions" });
    await search.getByRole("combobox").pressSequentially("Antigravity fixture");
    await search.getByRole("option", { name: /Antigravity fixture/ }).click();
    await expect(
      page.locator(".transcript").getByText("Pi transcript ready", { exact: true }),
    ).toBeVisible();
    const chooseAntigravity = async () => {
      await picker.click();
      const change = pickerDialog.getByRole("button", { name: /Change model/ });
      await expect(
        change.or(pickerDialog.getByRole("button", { name: /^Gemini · via Antigravity/ })),
      ).toBeVisible();
      if (await change.isVisible()) await change.click();
      await expect(
        pickerDialog.getByRole("button", { name: /^Gemini · via Antigravity/ }),
      ).toBeVisible();
      await pickerDialog.screenshot({ path: info.outputPath("antigravity-picker.png") });
      await pickerDialog.getByRole("button", { name: /^Gemini · via Antigravity/ }).click();
      await pickerDialog.getByRole("button", { name: "Apply", exact: true }).click();
    };
    await chooseAntigravity();
    await expect(picker).toContainText("Gemini · via Antigravity");
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
    await pickerDialog.getByRole("button", { name: /Change model/ }).click();
    await pickerDialog.getByRole("button", { name: /Fixture preset/ }).click();
    await expect(picker).not.toContainText("Antigravity");

    // Restore the fixture after the missing-CLI assertion.
    await rename(join(bin, "agy-disabled"), agy);
    await rm(join(project, "fixture-auth-required"));
    // Switch to the permanent chat. It opts in separately from the Project Session.
    await page.getByRole("button", { name: "Open Project Chat for project", exact: true }).click();
    await expect(
      page.getByText("The Project Chat example is an atlas", { exact: true }),
    ).toBeVisible();
    await chooseAntigravity();
    await expect(picker).toContainText("Gemini · via Antigravity");
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
      `fixture Cake ${JSON.stringify(
        ["Synthetic ACP to-do", "Denied ACP to-do", "Canceled ACP to-do"].map((title) => ({
          command: "todos.create",
          input: { title, description: "Disposable desktop smoke test" },
        })),
      )}`,
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(exportPrompt).toContainText("share its result with Google Antigravity");
    await expect(exportPrompt).toContainText(
      `Project (registered workspace): ${JSON.stringify(project)}`,
    );
    await expect(exportPrompt).toContainText("Arguments from Antigravity:");
    await expect(exportPrompt).toContainText("Synthetic ACP to-do");
    await expect(exportPrompt).toContainText("without another prompt");
    expect(await readFile(join(project, "fixture-mcp-evidence.ndjson"), "utf8")).not.toContain(
      '"committed"',
    );
    expect(await readFile(join(cakeHome, "state", "application.json"), "utf8")).not.toContain(
      "Synthetic ACP to-do",
    );
    await page.screenshot({
      path: info.outputPath("project-chat-cake-export.png"),
      animations: "disabled",
    });
    await exportPrompt.getByRole("combobox").selectOption({ label: "Allow once" });
    await exportPrompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(exportPrompt).toContainText("Denied ACP to-do");
    await expect(exportPrompt.getByRole("combobox")).toHaveValue("");
    await exportPrompt.getByRole("combobox").selectOption({ label: "Deny" });
    await exportPrompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(exportPrompt).toContainText("Canceled ACP to-do");
    await exportPrompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(exportPrompt).toHaveCount(0);
    await expect(page.locator(".transcript").getByText(/"committed": true/)).toBeVisible();
    const evidence = (await readFile(join(project, "fixture-mcp-evidence.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    expect(
      evidence.findings.map(
        ({ result }: { result: { isError: boolean; content: [{ text: string }] } }) =>
          result.content[0].text,
      ),
    ).toEqual([
      expect.stringContaining('"committed": true'),
      expect.stringContaining("did not approve"),
      expect.stringContaining("did not approve"),
    ]);
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(join(cakeHome, "state", "application.json"), "utf8"),
          ).data?.projects.find((item: { path: string }) => item.path === project)?.todos?.items,
      )
      .toEqual([
        expect.objectContaining({ title: "First draft fixture turn", revision: 0 }),
        expect.objectContaining({ title: "Synthetic ACP to-do", revision: 0 }),
      ]);
    await projectChat.fill('fixture Cake [{"command":"todos.list","input":{}}]');
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(exportPrompt).toContainText(
      `Project (registered workspace): ${JSON.stringify(project)}`,
    );
    await expect(exportPrompt).toContainText("Cake operation: todos.list");
    await page.screenshot({
      path: info.outputPath("project-chat-todo-list-export.png"),
      animations: "disabled",
    });

    // Real loss of the isolated renderer process, with its WebContents still alive.
    const window = await application.browserWindow(page);
    crashed = true;
    expect(
      await window.evaluate(async ({ webContents }) => {
        const gone = new Promise<void>((resolve) =>
          webContents.once("render-process-gone", () => resolve()),
        );
        webContents.forcefullyCrashRenderer();
        await gone;
        return webContents.isDestroyed();
      }),
    ).toBe(false);
    await expect
      .poll(async () =>
        (await readFile(join(project, "fixture-acp-wire.ndjson"), "utf8"))
          .trim()
          .split("\n")
          .at(-1),
      )
      .toContain('"method":"session/cancel"');
    const crashWire = (await readFile(join(project, "fixture-acp-wire.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(crashWire.at(-1).method).toBe("session/cancel");
    const crashBridge = crashWire.findLast((frame) => frame.method === "session/new").params
      .mcpServers[0];
    await expect
      .poll(async () =>
        fetch(crashBridge.url).then(
          () => "open",
          () => "closed",
        ),
      )
      .toBe("closed");
    const afterCrash = (await readFile(join(project, "fixture-mcp-evidence.ndjson"), "utf8"))
      .trim()
      .split("\n");
    expect(JSON.parse(afterCrash.at(-1) ?? "").findings).toBeUndefined();

    // The same WebContents can load a replacement document after the crash.
    await window.evaluate(async ({ webContents }) => {
      const loaded = new Promise<void>((resolve) => webContents.once("did-finish-load", resolve));
      webContents.reload();
      await loaded;
    });
  } finally {
    if (application && crashed) {
      // Playwright's graceful context close hangs after intentionally crashing this
      // target, even after reload. Exit only this isolated test process via main.
      const child = application.process();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        await application.evaluate(({ app }) => {
          setImmediate(() => app.exit(0));
        });
        await exited;
      }
    } else await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
