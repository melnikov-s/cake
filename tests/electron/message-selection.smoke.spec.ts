import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("selects rendered TypeScript and opens a continuous, resizable selection chat", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-message-selection-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "message-selection-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  const assistantMarkdown = [
    "The settings shape is explicit:",
    "",
    "```tsx",
    "interface UtilityModePreferences {",
    "  provider: string;",
    "  modelId: string;",
    "}",
    "```",
    "",
    "The unconfigured state stays empty."
  ].join("\n");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true })
  ]);
  await writeFile(join(userData, "window-state.json"), JSON.stringify({
    projectPath: project,
    selectedSessionId: sessionId,
    activeConversation: { kind: "project-session", workspacePath: project, sessionId },
    recentProjectPaths: [project],
    draft: "",
    theme: "dark",
    thinkingExpanded: false,
    draftsBySession: {}
  }));
  await writeFile(join(userData, "application.json"), JSON.stringify({
    schemaVersion: 1,
    projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp, resolvedSessionIds: [] }],
    trustedProjectPaths: []
  }));
  await writeFile(join(sessionDirectory, `${sessionId}.jsonl`), [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
    { type: "message", id: "user-1", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Show the settings shape" }], timestamp: 0 } },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp, message: { role: "assistant", content: [{ type: "text", text: assistantMarkdown }], api: "anthropic-messages", provider: "anthropic", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: { ...process.env, CAKE_ELECTRON_SMOKE: "1", CAKE_ELECTRON_USER_DATA: userData, CAKE_HOME: cakeHome }
  });

  try {
    const page = await application.firstWindow();
    const code = page.locator('[data-streamdown="code-block-body"] code');
    await expect(code).toContainText("UtilityModePreferences", { timeout: 20_000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"] code span span'))
      .some((token) => token.style.getPropertyValue("--sdm-c") !== "inherit"));
    await code.scrollIntoViewIfNeeded();
    const selectionTarget = await code.evaluate((element, selectedText) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(selectedText) ?? -1;
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + selectedText.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      throw new Error(`Could not locate ${selectedText}`);
    }, "UtilityModePreferences");

    await page.mouse.dblclick(selectionTarget.x, selectionTarget.y);

    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe("UtilityModePreferences");
    const action = page.getByRole("button", { name: "Chat about this" });
    await expect(action).toBeVisible();
    await action.click();

    const dialog = page.getByRole("dialog", { name: "Chat about this" });
    const input = page.getByLabel("Message about selected text");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".transcript .user-message").first()).toHaveText("UtilityModePreferences");
    await expect(dialog.locator(".transcript article > div:first-child").first()).toHaveText("You");
    await expect(dialog.locator(".chat-layout-compact")).toBeVisible();
    await expect(input).toBeFocused();
    await input.fill("Why is this interface shaped this way?");
    await expect(input).toHaveValue("Why is this interface shaped this way?");
    await expect(dialog.getByRole("button", { name: "Send" })).toBeEnabled();

    const dimensions = await dialog.evaluate((element) => {
      const dialogRect = element.getBoundingClientRect();
      const composerRect = element.querySelector(".workbench-composer")?.getBoundingClientRect();
      return {
        width: dialogRect.width,
        height: dialogRect.height,
        bottomSpace: composerRect ? dialogRect.bottom - composerRect.bottom : Number.POSITIVE_INFINITY,
        resize: getComputedStyle(element).resize
      };
    });
    expect(dimensions.width).toBe(520);
    expect(dimensions.height).toBe(520);
    expect(dimensions.bottomSpace).toBeLessThanOrEqual(14);
    expect(dimensions.resize).toBe("both");

    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".chat-embedded-workbench-composer")).toBeVisible();
    await expect(input).toBeVisible();
    await expect(dialog.locator(".transcript .user-message")).toHaveCount(2);
    await expect(dialog.locator(".transcript .user-message").nth(1)).toHaveText("Why is this interface shaped this way?");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
