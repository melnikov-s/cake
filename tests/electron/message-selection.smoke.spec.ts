import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("focuses annotation input and opens a continuous, resizable selection chat", async () => {
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
    "The unconfigured state stays empty.",
  ].join("\n");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      draftsBySession: {},
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Show the settings shape" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantMarkdown }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
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
    },
  });

  try {
    const page = await application.firstWindow();
    const code = page.locator('[data-streamdown="code-block-body"] code');
    await expect(code).toContainText("UtilityModePreferences", { timeout: 20_000 });
    await page.waitForFunction(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-streamdown="code-block-body"] code span span',
        ),
      ).some((token) => token.style.getPropertyValue("--sdm-c") !== "inherit"),
    );

    await page.getByRole("button", { name: "View response fullscreen" }).click({ force: true });
    await expect(page.getByRole("dialog", { name: "Cake" })).toBeVisible();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect(page.getByRole("dialog", { name: "Cake" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
    expect(page.isClosed()).toBe(false);

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

    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
      .toBe("UtilityModePreferences");
    await application.evaluate(({ Menu }) => {
      const buildFromTemplate = Menu.buildFromTemplate.bind(Menu);
      let nextLabel = "Add annotation";
      Menu.buildFromTemplate = (template) => {
        const menu = buildFromTemplate(template);
        menu.popup = (options) => {
          const item = menu.items.find((candidate) => candidate.label === nextLabel);
          if (!item?.click) throw new Error(`Expected ${nextLabel} menu item`);
          if (!item.icon || item.icon.isEmpty())
            throw new Error(`Expected ${nextLabel} menu item to have an icon`);
          nextLabel = "Chat about this";
          item.click(item, options.window!, { triggeredByAccelerator: false });
          options.callback?.();
        };
        return menu;
      };
    });
    const openSelectionMenu = () =>
      page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y);
        if (!target) throw new Error("Could not resolve selection target");
        target.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          }),
        );
      }, selectionTarget);

    await openSelectionMenu();
    const annotationDialog = page.getByRole("dialog", { name: "Add annotation" });
    const annotationInput = page.getByLabel("Annotation comment");
    await expect(annotationDialog).toBeVisible();
    await expect(annotationInput).toBeFocused();
    await annotationInput.pressSequentially("Remember this type");
    await expect(annotationInput).toHaveValue("Remember this type");
    await expect(annotationDialog.getByRole("button", { name: "Add annotation" })).toBeEnabled();
    await annotationInput.press("Enter");
    await expect(annotationDialog).toHaveCount(0);

    await page.mouse.dblclick(selectionTarget.x, selectionTarget.y);
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
      .toBe("UtilityModePreferences");
    await openSelectionMenu();

    const dialog = page.getByRole("dialog", { name: "Chat about this" });
    const input = page.getByLabel("Message about selected text");
    await expect(dialog).toBeVisible();
    const userMessages = dialog
      .locator('[data-slot="message"]')
      .filter({ has: page.locator('[data-slot="message-label"]', { hasText: "You" }) });
    await expect(userMessages.first().locator('[data-slot="message-content"]')).toHaveText(
      "UtilityModePreferences",
    );
    await expect(userMessages.first().locator('[data-slot="message-label"]')).toHaveText("You");
    await expect(dialog.locator(".chat-layout-compact")).toBeVisible();
    await expect(input).toBeFocused();
    await input.pressSequentially("Why is this interface shaped this way?");
    await expect(input).toHaveValue("Why is this interface shaped this way?");
    await expect(dialog.getByRole("button", { name: "Send" })).toBeEnabled();

    // Default popup: fixed 26rem width, content-sized height capped at 34rem.
    const defaultGeometry = await dialog.evaluate((element) => {
      const dialogRect = element.getBoundingClientRect();
      const composerRect = element.querySelector(".workbench-composer")?.getBoundingClientRect();
      return {
        width: dialogRect.width,
        height: dialogRect.height,
        bottomSpace: composerRect
          ? dialogRect.bottom - composerRect.bottom
          : Number.POSITIVE_INFINITY,
      };
    });
    expect(defaultGeometry.width).toBe(416);
    expect(defaultGeometry.height).toBeLessThanOrEqual(544);
    expect(defaultGeometry.bottomSpace).toBeLessThanOrEqual(14);

    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".chat-embedded-workbench-composer")).toBeVisible();
    await expect(input).toBeVisible();
    await expect(userMessages).toHaveCount(2);
    await expect(userMessages.nth(1).locator('[data-slot="message-content"]')).toHaveText(
      "Why is this interface shaped this way?",
    );

    // Resize freely: drag the east edge narrower, then the south edge shorter.
    const eastBox = await dialog.boundingBox();
    if (!eastBox) throw new Error("Expected the selection chat dialog to have a bounding box");
    await page.mouse.move(eastBox.x + eastBox.width - 4, eastBox.y + eastBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(eastBox.x + eastBox.width - 84, eastBox.y + eastBox.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    const narrowed = await dialog.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.round(narrowed)).toBe(Math.round(eastBox.width) - 80);

    const southBox = await dialog.boundingBox();
    if (!southBox) throw new Error("Expected the selection chat dialog to have a bounding box");
    await page.mouse.move(southBox.x + southBox.width / 2, southBox.y + southBox.height - 4);
    await page.mouse.down();
    await page.mouse.move(southBox.x + southBox.width / 2, southBox.y + southBox.height - 64, {
      steps: 6,
    });
    await page.mouse.up();
    const resizedGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    expect(resizedGeometry.width).toBe(Math.round(eastBox.width) - 80);
    expect(resizedGeometry.height).toBe(Math.round(southBox.height) - 60);

    const dragHeader = async () => {
      const headerBox = await dialog.locator("header").boundingBox();
      if (!headerBox) throw new Error("Expected the selection chat dialog to have a header");
      await page.mouse.dblclick(
        headerBox.x + headerBox.width / 2,
        headerBox.y + headerBox.height / 2,
      );
    };

    // Double-click the header to maximize; double-click again to restore.
    await dragHeader();
    const maximizedGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    });
    expect(maximizedGeometry.left).toBe(0);
    expect(maximizedGeometry.top).toBe(0);
    expect(maximizedGeometry.width).toBe(maximizedGeometry.innerWidth);
    expect(maximizedGeometry.height).toBe(maximizedGeometry.innerHeight);

    await dragHeader();
    const restoredGeometry = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    expect(restoredGeometry).toEqual(resizedGeometry);

    // The green traffic light maximizes and restores; red closes back to the
    // underlying conversation.
    await dialog.getByRole("button", { name: "Maximize chat about this" }).click();
    const lightMaximized = await dialog.evaluate(
      (element) => element.getBoundingClientRect().width === window.innerWidth,
    );
    expect(lightMaximized).toBe(true);
    await dialog.getByRole("button", { name: "Restore chat about this" }).click();
    const lightRestored = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    expect(lightRestored).toEqual(resizedGeometry);
    await dialog.getByRole("button", { name: "Close chat about this" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
