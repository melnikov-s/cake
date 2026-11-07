import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

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
  test(`workspace companion tabs align, fill and remain keyboard-accessible (${theme})`, async () => {
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
      await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
      await expect(page.getByRole("region", { name: "Browser workspace" })).toBeVisible();
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
      const input = page.getByRole("combobox", { name: "Message", exact: true });
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
      await page.getByRole("button", { name: "Open VS Code", exact: true }).click();
      await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
      await expectAlignedTabs(strip);
      await todos.click();
      await expect(todos).toHaveAttribute("aria-pressed", "true");
      await chat.click();
      await expect(input).toHaveValue("Keep this companion draft");
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
