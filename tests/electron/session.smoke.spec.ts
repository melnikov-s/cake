import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveCakePaths } from "../../src/config/CakePaths";
import { workingDirectorySessionPath } from "../../src/services/storage/session-files";
import { windowState } from "../fixtures/window-state";

import { createSessionInProject, showSessions } from "./fixtures/workspace-navigation";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("opens a durable Pi session in the sandboxed desktop and survives a Pi runtime reset", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-s1-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "system" }));
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
    }),
  );

  // The reset path needs a real Project Session. Do not rely on a global-chat
  // collection row (the permanent coordinator is a separate navigation entry).
  const paths = resolveCakePaths({
    env: { CAKE_HOME: cakeHome },
    piAgentDirectory: join(cakeHome, "pi"),
  });
  const existing = SessionManager.create(
    project,
    workingDirectorySessionPath(project, paths.piSessions),
  );
  existing.appendSessionInfo("Existing investigation");
  existing.appendMessage({ role: "user", content: "Earlier investigation", timestamp: Date.now() });
  existing.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Earlier investigation recorded." }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

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
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await showSessions(page);
    await expect(
      page.getByRole("button", { name: "New session in any project", exact: true }),
    ).toBeVisible();
    const configuration = page.getByRole("button", { name: "Model configuration" });
    await expect(configuration).toBeVisible();
    await configuration.click();
    const modelSearch = page.getByLabel("Search presets and models");
    const changeModel = page.getByRole("button", { name: /Change model/ });
    await expect
      .poll(async () => (await modelSearch.isVisible()) || (await changeModel.isVisible()))
      .toBe(true);
    if (await changeModel.isVisible()) await changeModel.click();
    await expect(modelSearch).toBeVisible();
    await expect(page.getByRole("button", { name: /Manage model presets/ })).toBeVisible();
    await configuration.click();
    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Workspace", exact: true })).toBeHidden();
    await expect(rail.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await rail.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByLabel("Settings sections")).toBeVisible();
    await page.getByRole("button", { name: /Agent/ }).click();
    const autoCompact = page
      .getByRole("region", { name: "Agent behavior" })
      .getByLabel("Auto-compact");
    await expect(autoCompact).toBeVisible();
    const autoCompactWasChecked = await autoCompact.isChecked();
    await autoCompact.click();
    if (autoCompactWasChecked) await expect(autoCompact).not.toBeChecked();
    else await expect(autoCompact).toBeChecked();
    await page.getByRole("button", { name: "Network & privacy" }).click();
    await expect(
      page.getByRole("region", { name: "Network" }).getByLabel("Provider transport"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Appearance" }).click();
    await expect(page.getByRole("button", { name: "System", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Back to chat" }).click();
    await showSessions(page);
    await expect(
      page.locator(".session-item").filter({ hasText: "Existing investigation" }),
    ).toBeVisible();
    const sessionCountBeforeNewChat = await page.locator(".session-item").count();
    await createSessionInProject(page, /^project(?: |$)/i);
    const newChatComposer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(newChatComposer).toBeVisible();
    await expect(newChatComposer).toBeFocused();
    await newChatComposer.pressSequentially("Immediate draft");
    await expect(newChatComposer).toHaveValue("Immediate draft");
    await expect(page.locator(".session-item")).toHaveCount(sessionCountBeforeNewChat);

    // New Chat is one durable staged composer, not a sidebar session. Navigating
    // away and choosing New Chat again must recover the exact in-progress input.
    await page
      .getByRole("navigation", { name: "Projects and global utilities" })
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await createSessionInProject(page, /^project(?: |$)/i);
    await expect(newChatComposer).toHaveValue("Immediate draft");
    await expect(newChatComposer).toBeFocused();
    await expect(page.locator(".session-item")).toHaveCount(sessionCountBeforeNewChat);

    const draftChoice = page.getByRole("button", { name: "Draft", exact: true });
    await draftChoice.click();
    await expect(draftChoice).toHaveAttribute("aria-pressed", "true");
    const draftSendButton = page.getByRole("button", { name: "Create draft" });
    await expect(draftSendButton).toBeEnabled();
    await draftSendButton.click();
    await expect(page.getByText("Immediate draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toHaveCount(0);
    // The saved draft's input-free composer puts the assistant beside the model picker.
    // At compact widths they must retain separate hit targets.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(840, 600);
    });
    const assistant = page.locator('[data-slot="composer-leading-accessory"] button');
    const modelPicker = page.getByRole("button", { name: "Model configuration" });
    await expect(assistant).toBeVisible();
    await expect(modelPicker).toBeVisible();
    const assistantBounds = await assistant.boundingBox();
    const pickerBounds = await modelPicker.boundingBox();
    expect(assistantBounds!.x + assistantBounds!.width).toBeLessThanOrEqual(pickerBounds!.x);
    await modelPicker.click();
    await expect(page.getByRole("dialog", { name: "Model configuration" })).toBeVisible();
    await modelPicker.click();
    // An explicitly saved draft is the pseudo-session that belongs in the sidebar.
    await expect(page.locator(".session-item")).toHaveCount(sessionCountBeforeNewChat + 1);
    await expect(page.getByRole("navigation", { name: "Conversation breadcrumb" })).toContainText(
      "New chat",
    );
    await expect(page.getByLabel("Back to chat")).toHaveCount(0);
    await page.evaluate(() => {
      const longTitle = `Investigate-${"very-long-session-name-".repeat(500)}`;
      const headerTitle = document.querySelector<HTMLElement>(
        '[aria-label="Conversation breadcrumb"] [aria-current="page"]',
      );
      const sidebarTitle = document.querySelector<HTMLElement>(".session-row span");
      if (headerTitle) headerTitle.textContent = longTitle;
      if (sidebarTitle) sidebarTitle.textContent = longTitle;
    });
    expect(
      await page.evaluate(() => {
        const transcript = document.querySelector(".transcript");
        const composer = document.querySelector(".workbench-composer");
        const workspace = document.querySelector('[data-slot="workspace"]');
        const conversation = document.querySelector('[aria-label="Conversation"]');
        const workspaceRect = workspace?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        const conversationRect = conversation?.getBoundingClientRect();
        const visibleWorkspaceCenter = workspaceRect
          ? workspaceRect.left + workspaceRect.width / 2
          : 0;
        return {
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          transcriptFits: !transcript || transcript.scrollWidth <= transcript.clientWidth,
          workspaceFits: !workspaceRect || workspaceRect.right <= innerWidth,
          composerFits: !composerRect || composerRect.right <= innerWidth,
          composerCentered:
            !composerRect ||
            Math.abs(composerRect.left + composerRect.width / 2 - visibleWorkspaceCenter) < 1,
          conversationCentered:
            !conversationRect ||
            Math.abs(conversationRect.left + conversationRect.width / 2 - visibleWorkspaceCenter) <
              1,
        };
      }),
    ).toEqual({
      documentFits: true,
      transcriptFits: true,
      workspaceFits: true,
      composerFits: true,
      composerCentered: true,
      conversationCentered: true,
    });

    await page.locator(".session-item").filter({ hasText: "Existing investigation" }).click();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();

    const rendererCapabilities = await page.evaluate(() => ({
      require: typeof Reflect.get(window, "require"),
      process: typeof Reflect.get(window, "process"),
      rawElectron: typeof Reflect.get(window, "electron"),
      bridgeKeys: Object.keys(window.cake).sort(),
    }));
    expect(rendererCapabilities).toEqual({
      require: "undefined",
      process: "undefined",
      rawElectron: "undefined",
      bridgeKeys: ["rpc"],
    });

    const retainedComposer = page.getByRole("combobox", { name: "Message", exact: true });
    await retainedComposer.click();
    await retainedComposer.pressSequentially("Persist this draft");
    await expect(retainedComposer).toBeFocused();
    await expect(retainedComposer).toHaveValue("Persist this draft");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await application.evaluate(() => {
      const reset = Reflect.get(globalThis, "cakeSmokeResetPi");
      if (typeof reset !== "function") throw new Error("Pi reset hook is unavailable");
      reset();
    });

    await expect(page.getByText(/Pi runtime stopped/)).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toHaveValue(
      "Persist this draft",
    );
    expect(page.isClosed()).toBe(false);
    await page.getByRole("button", { name: "Restart and reopen" }).click();
    await expect(page.getByText(/Pi runtime stopped/)).not.toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toHaveValue(
      "Persist this draft",
      { timeout: 20_000 },
    );
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
