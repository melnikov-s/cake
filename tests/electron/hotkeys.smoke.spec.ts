import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

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
  await writeFile(join(userData, "window-state.json"), windowState({ project }));
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    const messageInput = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(messageInput).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const pressCommandBackquote =
      process.platform === "darwin"
        ? () =>
            application.evaluate(({ BrowserWindow, Menu }) => {
              const item = Menu.getApplicationMenu()
                ?.items.flatMap((entry) => entry.submenu?.items ?? [])
                .find((entry) => entry.label === "Toggle Terminal");
              if (!item) throw new Error("Toggle Terminal menu item missing");
              if (item.accelerator !== "CommandOrControl+`")
                throw new Error(`Unexpected Toggle Terminal accelerator: ${item.accelerator}`);
              const window = BrowserWindow.getFocusedWindow();
              item.click(
                { triggeredByAccelerator: true, metaKey: true },
                window,
                window?.webContents,
              );
            })
        : () => page.keyboard.press("Control+Backquote");

    await page.keyboard.press(`${modifier}+G`);
    await expect(page.locator('[data-slot="ui-hint-overlay"]')).toBeVisible();
    await expect(page.locator('[data-slot="ui-hint"]').first()).toBeVisible();
    const messageHint = await messageInput.getAttribute("data-cake-hint-label");
    expect(messageHint).toBeTruthy();
    await page.keyboard.type(messageHint!);
    await expect(messageInput).toBeFocused();
    await expect(page.locator('[data-slot="ui-hint-overlay"]')).toHaveCount(0);

    const settingsButton = page
      .getByRole("complementary")
      .getByLabel("Open settings", { exact: true });
    await page.keyboard.press(`${modifier}+G`);
    const settingsHint = await settingsButton.getAttribute("data-cake-hint-label");
    expect(settingsHint).toBeTruthy();
    await page.keyboard.type(settingsHint!);
    await page.getByRole("button", { name: "Hotkeys" }).click();
    await expect(page.getByRole("heading", { name: "Hotkeys" })).toBeVisible();

    const terminalShortcut = page.getByRole("button", { name: "Toggle terminal shortcut" });
    await expect(terminalShortcut).toContainText(process.platform === "darwin" ? "⌘`" : "Ctrl+`");

    await page.getByRole("button", { name: "Back to chat" }).click();
    const terminal = page.locator('section[aria-label="Terminal"]');
    await expect(terminal).toHaveAttribute("aria-hidden", "true");
    await pressCommandBackquote();
    await expect(terminal).toHaveAttribute("aria-hidden", "false");
    await pressCommandBackquote();
    await expect(terminal).toHaveAttribute("aria-hidden", "true");

    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.getByRole("button", { name: "Hotkeys" }).click();
    const sidebarShortcut = page.getByRole("button", { name: "Toggle sidebar shortcut" });
    await sidebarShortcut.click();
    await pressCommandBackquote();
    await expect(sidebarShortcut).toContainText(process.platform === "darwin" ? "⌘`" : "Ctrl+`");
    await expect(terminalShortcut).toContainText("Not assigned");
    await page.getByRole("button", { name: "Back to chat" }).click();
    await pressCommandBackquote();
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0);
    await pressCommandBackquote();
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();

    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.getByRole("button", { name: "Hotkeys" }).click();
    await page.getByRole("button", { name: "Reset all" }).click();
    await sidebarShortcut.click();
    await expect(sidebarShortcut).toBeFocused();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press(`${modifier}+Shift+B`);
    await expect(sidebarShortcut).toContainText(
      process.platform === "darwin" ? "⌘⇧B" : "Ctrl+Shift+B",
    );

    await expect(
      page.getByRole("button", { name: "Toggle Browser Mode shortcut", exact: true }),
    ).toHaveText("Not assigned");

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

    // Window snapshots are debounced; wait for the real storage boundary before reloading.
    await expect(async () => {
      const snapshot: unknown = JSON.parse(
        await readFile(join(userData, "window-state.json"), "utf8"),
      );
      expect(snapshot).toMatchObject({
        data: {
          children: {
            settingsStore: {
              children: {
                hotkeys: {
                  state: {
                    bindings: {
                      "toggle-sidebar": "Mod+Shift+B",
                      "toggle-browser": "",
                      "toggle-terminal": "Mod+Shift+Y",
                    },
                  },
                },
              },
            },
          },
        },
      });
    }).toPass({ timeout: 10_000 });
    await page.reload();
    await expect(messageInput).toBeVisible();
    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.getByRole("button", { name: /^Hotkeys\b/ }).click();
    await expect(sidebarShortcut).toHaveText(
      process.platform === "darwin" ? "⌘⇧B" : "Ctrl+Shift+B",
    );
    await expect(terminalShortcut).toHaveText(
      process.platform === "darwin" ? "⌘⇧Y" : "Ctrl+Shift+Y",
    );
    await expect(
      page.getByRole("button", { name: "Toggle Browser Mode shortcut", exact: true }),
    ).toHaveText("Not assigned");
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.keyboard.press(`${modifier}+B`);
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
    await page.keyboard.press(`${modifier}+Shift+B`);
    await expect(page.locator('[data-slot="sidebar"]')).toHaveCount(0);
    await page.keyboard.press(`${modifier}+Shift+B`);
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
