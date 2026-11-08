import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function expectSearchGap(search: Locator, header: Locator) {
  const searchBox = (await search.boundingBox())!;
  const headerBox = (await header.boundingBox())!;
  expect(searchBox.y - (headerBox.y + headerBox.height)).toBe(8);
}

async function expectAlignedTabs(strip: Locator) {
  const geometry = await strip.evaluate((element) => {
    const header = element.parentElement!;
    const pane = header.parentElement!;
    const box = (node: Element) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      header: box(header),
      pane: box(pane),
      strip: box(element),
      tabs: [...element.querySelectorAll("button")].map(box),
    };
  });
  expect(geometry.header.height).toBe(40);
  // The pane's single left divider is the only horizontal inset.
  expect(geometry.strip.x).toBe(geometry.pane.x + 1);
  expect(geometry.strip.width).toBe(geometry.pane.width - 1);
  expect(geometry.strip.y).toBe(geometry.header.y);
  expect(geometry.strip.height).toBe(geometry.header.height - 1);
  expect(geometry.tabs).toHaveLength(3);
  // Keep the original track's 1px border, 2px padding and 2px segment gaps.
  const tabWidth = (geometry.strip.width - 6 - 4) / 3;
  for (const [index, tab] of geometry.tabs.entries()) {
    expect(tab.y).toBe(geometry.strip.y + 3);
    expect(tab.height).toBe(geometry.strip.height - 6);
    expect(tab.width).toBeCloseTo(tabWidth, 1);
    expect(tab.x).toBeCloseTo(geometry.strip.x + 3 + (tabWidth + 2) * index, 1);
  }
  return geometry.header;
}

for (const theme of ["dark", "light"] as const) {
  test(`workspace companion tabs align, fill and remain keyboard-accessible (${theme})`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "cake-companion-tabs-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    await Promise.all([
      mkdir(paths.project, { recursive: true }),
      mkdir(paths.userData, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowState({ project: paths.project, theme }),
    );
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: paths.project, name: "Tab strip", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
      }),
    );
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900),
      );
      // Startup may restore the global Cake Chat; explicitly select a project-backed workspace.
      await page
        .getByRole("button", { name: "Open Project Chat for Tab strip", exact: true })
        .click();
      const modeSelector = page.getByRole("group", { name: "Conversation workspace", exact: true });
      await expect(modeSelector).toBeVisible();
      const windowHeader = page.locator('[data-slot="workspace-header"]');
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      const workspaceHeader = workspace.locator("header");
      const workspaceTabs = workspace.getByRole("group", { name: "Workspace content" });
      const expectTopBarGeometry = async () => {
        const header = (await windowHeader.boundingBox())!;
        // 52px content height + its bottom rule is now 44px + the same rule.
        expect(header.height).toBe(45);
        for (const control of [
          ...(await modeSelector.getByRole("button").all()),
          page.locator('[data-slot="shell-workspace-toggle"]'),
        ]) {
          const box = (await control.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(28);
          expect(box.y).toBeGreaterThanOrEqual(header.y);
          expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height - 1);
        }
        for (const tab of await workspaceTabs.getByRole("button").all()) {
          const box = (await tab.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(24);
          expect(box.y).toBeGreaterThanOrEqual(header.y);
          expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height - 1);
        }
        expect(await workspaceHeader.boundingBox()).toMatchObject({
          y: header.y,
          height: header.height,
        });
      };
      await expectTopBarGeometry();
      await workspaceTabs.getByRole("button", { name: /^To-dos/ }).click();
      await expectSearchGap(
        page.getByRole("searchbox", { name: "Search to-dos" }),
        workspaceHeader,
      );
      await workspaceTabs.getByRole("button", { name: /^Sessions/ }).click();
      await expectSearchGap(
        page.getByRole("searchbox", { name: "Search sessions" }),
        workspaceHeader,
      );
      const modes = modeSelector.getByRole("button");
      await expect(modes).toHaveCount(3);
      for (const name of ["Main", "VS Code", "Browser"]) {
        const button = modeSelector.getByRole("button", { name, exact: true });
        await expect(button).toHaveText("");
        await expect(button).toHaveCSS("border-width", "0px");
        await expect(button.locator("svg")).toHaveCSS("width", "20px");
        await expect(button.locator("svg")).toHaveCSS("height", "20px");
      }
      await expect(modeSelector).toHaveCSS("border-width", "0px");
      const tools = page.getByRole("group", { name: "Workspace tools", exact: true });
      await expect(tools).toHaveCSS("border-width", "0px");
      await expect(modeSelector.getByRole("button", { name: "Terminal", exact: true })).toHaveCount(
        0,
      );
      const terminal = tools.getByRole("button", { name: "Terminal", exact: true });
      const terminalBox = (await terminal.boundingBox())!;
      const modeBox = (await modeSelector.boundingBox())!;
      expect(terminalBox.x - (modeBox.x + modeBox.width)).toBeGreaterThanOrEqual(16);
      await expect(terminal.locator("svg")).toHaveCSS("width", "16px");
      const main = modeSelector.getByRole("button", { name: "Main", exact: true });
      await expect(main).toHaveAttribute("aria-pressed", "true");
      await modeSelector.getByRole("button", { name: "VS Code", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(main).toBeFocused();
      await expect(main).toHaveCSS("outline-style", "solid");
      await expect(page.getByRole("tooltip", { name: "Main", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`main-toolbar-${theme}.png`) });
      await page.keyboard.press("Shift+Tab");
      await page.mouse.move(1, 200);
      const paneToggle = page.locator('[data-slot="shell-workspace-toggle"]');
      const originalTogglePosition = await paneToggle.boundingBox();
      const originalPosition = await modeSelector.boundingBox();
      const expectStableSelector = async () => {
        const current = await modeSelector.boundingBox();
        expect(current).not.toBeNull();
        expect(current!.x).toBeCloseTo(originalPosition!.x, 0);
        expect(current!.y).toBeCloseTo(originalPosition!.y, 0);
        expect(current!.width).toBeCloseTo(originalPosition!.width, 0);
        expect(await paneToggle.boundingBox()).toEqual(originalTogglePosition);
      };
      await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
      await expectStableSelector();
      await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
      await expectStableSelector();
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await expect(page.getByRole("region", { name: "Browser workspace" })).toBeVisible();
      await expect(
        modeSelector.getByRole("button", { name: "Browser", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(main).toHaveAttribute("aria-pressed", "false");
      await expectStableSelector();
      const strip = page.getByRole("group", { name: "Companion content", exact: true });
      const chat = strip.getByRole("button", { name: "Chat", exact: true });
      const todos = strip.getByRole("button", { name: "Todos", exact: true });
      const sessions = strip.getByRole("button", { name: "Sessions", exact: true });
      const address = page.getByRole("textbox", { name: "Browser address", exact: true });
      const toolbar = address.locator("..");
      const checkAlignment = async () => {
        const header = await expectAlignedTabs(strip);
        const browser = (await toolbar.boundingBox())!;
        expect(header.y).toBe(browser.y);
        expect(header.height).toBe(browser.height);
      };
      await checkAlignment();
      // Selecting Sessions in Main also selects it in the tool companion.
      await chat.click();
      const input = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
      await input.fill("Keep this companion draft");
      await expect(input).toHaveValue("Keep this companion draft");
      // Plain Tab intentionally focuses the composer; Shift+Tab keeps native traversal.
      await sessions.focus();
      await page.keyboard.press("Shift+Tab");
      await expect(todos).toBeFocused();
      await expect(todos).toHaveCSS("outline-offset", "1px");
      await expect(todos).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Enter");
      await expect(todos).toHaveAttribute("aria-pressed", "true");
      await expect(chat).toHaveAttribute("aria-pressed", "false");
      await sessions.focus();
      await expect(sessions).toBeFocused();
      await page.keyboard.press("Space");
      await expect(sessions).toHaveAttribute("aria-pressed", "true");
      await expectSearchGap(
        page.getByRole("searchbox", { name: "Search sessions" }),
        strip.locator(".."),
      );
      await page.screenshot({ path: testInfo.outputPath(`browser-sessions-${theme}.png`) });
      await chat.click();
      await expect(input).toHaveValue("Keep this companion draft");
      const resize = page.getByRole("separator", { name: "Resize current session sidebar" });
      for (const key of ["Home", "End"]) {
        await resize.press(key);
        await checkAlignment();
      }
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 900),
      );
      await checkAlignment();
      await page.getByRole("button", { name: "VS Code", exact: true }).click();
      await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
      await expectAlignedTabs(strip);
      await todos.click();
      await expect(todos).toHaveAttribute("aria-pressed", "true");
      await chat.click();
      await expect(input).toHaveValue("Keep this companion draft");

      // Compare again at this fixed narrower window size.
      const narrowPosition = await modeSelector.boundingBox();
      const narrowTogglePosition = await paneToggle.boundingBox();
      const expectStableNarrowSelector = async () => {
        const current = await modeSelector.boundingBox();
        expect(current!.x).toBeCloseTo(narrowPosition!.x, 0);
        expect(current!.y).toBeCloseTo(narrowPosition!.y, 0);
        expect(current!.width).toBeCloseTo(narrowPosition!.width, 0);
        expect(await paneToggle.boundingBox()).toEqual(narrowTogglePosition);
      };
      const toggle = page.locator('[data-slot="shell-workspace-toggle"]');
      await page.mouse.move(500, 700);
      const neutralColor = await toggle.evaluate((element) => getComputedStyle(element).color);
      const toggleBounds = await toggle.boundingBox();
      const expectNeutralFixedToggle = async () => {
        await page.mouse.move(500, 700);
        await expect(toggle).toHaveCSS("color", neutralColor);
        await expect(toggle).not.toHaveAttribute("aria-pressed");
        await expect(toggle.locator("svg path")).toHaveAttribute("d", "M15 4v16");
        expect(await toggle.boundingBox()).toEqual(toggleBounds);
      };
      const companion = page.getByRole("complementary", {
        name: "Current conversation companion",
        exact: true,
      });
      for (const mode of ["browser", "vscode"]) {
        if (mode === "browser")
          await page.getByRole("button", { name: "Browser", exact: true }).click();
        else await page.getByRole("button", { name: "VS Code", exact: true }).click();
        const workspace = page.getByRole("region", {
          name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
          exact: true,
        });
        await expect(workspace).toBeVisible();
        await expect(toggle).toHaveCount(1);
        await expect(
          page.locator('[data-slot="header-chat-toggle"], [data-slot="header-sidebar-toggle"]'),
        ).toHaveCount(0);
        for (const tab of [chat, todos, sessions]) {
          await tab.click();
          if (tab !== chat) {
            await expectSearchGap(
              page.getByRole("searchbox", {
                name: tab === sessions ? "Search sessions" : "Search to-dos",
              }),
              strip.locator(".."),
            );
          }
          await expect(toggle).toHaveAttribute("aria-expanded", "true");
          await expectNeutralFixedToggle();
          await toggle.click();
          await expect(companion).toBeHidden();
          await expect(workspace).toBeVisible();
          await expect(toggle).toBeVisible();
          await expect(toggle).toHaveAccessibleName("Open Workspace");
          await expect(toggle).toHaveAttribute("aria-expanded", "false");
          await expectNeutralFixedToggle();
          await expectStableNarrowSelector();
          // Restore from the retained right-hand control using the keyboard too.
          await toggle.focus();
          await toggle.press("Enter");
          await expect(companion).toBeVisible();
          await expectNeutralFixedToggle();
          await expect(tab).toHaveAttribute("aria-pressed", "true");
          await expectStableNarrowSelector();
          await expect(workspace).toBeVisible();
        }
      }
      await toggle.click();
      await page.screenshot({ path: testInfo.outputPath(`collapsed-${theme}.png`) });
      await page.getByRole("button", { name: "Main", exact: true }).click();
      await expect(input).toBeVisible();
      await expectStableNarrowSelector();
      const accessory = page.getByRole("complementary", { name: "Workspace", exact: true });
      await expect(accessory).toBeVisible();
      await expectTopBarGeometry();
      await workspaceTabs.getByRole("button", { name: /^Sessions/ }).click();
      await expectSearchGap(
        page.getByRole("searchbox", { name: "Search sessions" }),
        workspaceHeader,
      );
      await page.screenshot({ path: testInfo.outputPath(`narrow-main-sessions-${theme}.png`) });
      await toggle.click();
      await expect(accessory).toBeHidden();
      await expectNeutralFixedToggle();
      await expectStableNarrowSelector();
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("Keep this companion draft");
      await toggle.click();
      await expect(accessory).toBeVisible();
      await expectNeutralFixedToggle();
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      // Browser preserves manual collapse; explicit VS Code entry reveals Chat.
      await expect(companion).toBeHidden();
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(companion).toBeVisible();
      await toggle.click();
      await page.getByRole("button", { name: "VS Code", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "VS Code workspace", exact: true }),
      ).toBeVisible();
      await expect(companion).toBeVisible();
      await expectStableNarrowSelector();
      await chat.click();
      await expect(input).toHaveValue("Keep this companion draft");
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
