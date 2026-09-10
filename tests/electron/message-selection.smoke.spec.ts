import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("focuses annotation input and opens a responsive, resizable selection side chat", async () => {
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
    const fullscreen = page.getByRole("dialog", { name: "Cake" });
    await expect(fullscreen).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen Cake" }).click();
    await expect(fullscreen).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();

    await page.getByText("The settings shape is explicit:").hover();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Alt+Enter");
    await expect(fullscreen).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen Cake" }).click();
    await expect(fullscreen).toHaveCount(0);

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

    const dialog = page.getByRole("complementary", { name: "Chat about this" });
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

    const layout = page.locator('[data-slot="side-chat-layout"]');
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    const defaultWidth = await dialog.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.round(defaultWidth)).toBe(416);

    const resizeHandle = page.getByRole("separator", { name: "Resize side chat" });
    await resizeHandle.focus();
    await resizeHandle.press("ArrowLeft");
    await expect
      .poll(() => dialog.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
      .toBe(Math.round(defaultWidth) + 16);

    await expect(dialog.locator(".chat-embedded-workbench-composer")).toBeVisible();

    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(760, 800),
    );
    await expect(layout).toHaveAttribute("data-presentation", "replacement");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeHidden();

    await dialog.getByRole("button", { name: "Close Chat about this" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
