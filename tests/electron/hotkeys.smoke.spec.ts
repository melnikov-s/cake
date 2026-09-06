import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("remaps application hotkeys from Settings", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-hotkeys-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ projectPath: project, recentProjectPaths: [project], draft: "" }),
  );
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
      trustedProjectPaths: [],
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
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.getByRole("button", { name: "Hotkeys" }).click();
    await expect(page.getByRole("heading", { name: "Hotkeys" })).toBeVisible();

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const terminalShortcut = page.getByRole("button", { name: "Toggle terminal shortcut" });
    await expect(terminalShortcut).toContainText(process.platform === "darwin" ? "⌘`" : "Ctrl+`");

    await page.getByRole("button", { name: "Back to chat" }).click();
    const terminal = page.locator('section[aria-label="Terminal"]');
    await expect(terminal).toHaveAttribute("aria-hidden", "true");
    await page.keyboard.press(`${modifier}+Backquote`);
    await expect(terminal).toHaveAttribute("aria-hidden", "false");
    await page.keyboard.press(`${modifier}+Backquote`);
    await expect(terminal).toHaveAttribute("aria-hidden", "true");

    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.getByRole("button", { name: "Hotkeys" }).click();
    const sidebarShortcut = page.getByRole("button", { name: "Toggle sidebar shortcut" });
    await sidebarShortcut.click();
    await expect(sidebarShortcut).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press(`${modifier}+Shift+B`);
    await expect(sidebarShortcut).toContainText(
      process.platform === "darwin" ? "⌘⇧B" : "Ctrl+Shift+B",
    );

    await terminalShortcut.click();
    await expect(terminalShortcut).toBeFocused();
    await page.keyboard.press(`${modifier}+Shift+Y`);
    await expect(terminalShortcut).toContainText(
      process.platform === "darwin" ? "⌘⇧Y" : "Ctrl+Shift+Y",
    );
    await page.getByRole("button", { name: "Back to chat" }).click();
    await page.keyboard.press(`${modifier}+B`);
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
    await page.keyboard.press(`${modifier}+Shift+B`);
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0);
    await page.keyboard.press(`${modifier}+Shift+B`);
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();

    await expect(terminal).toHaveAttribute("aria-hidden", "true");
    await page.keyboard.press(`${modifier}+Shift+Y`);
    await expect(terminal).toHaveAttribute("aria-hidden", "false");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
