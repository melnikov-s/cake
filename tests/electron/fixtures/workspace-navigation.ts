import { expect, type ElectronApplication, type Page } from "@playwright/test";

/** Chooses the real native Project Settings action without displaying an OS popup. */
export async function openProjectSettings(
  application: ElectronApplication,
  page: Page,
  name: RegExp,
) {
  await application.evaluate(({ Menu }) => {
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = build(template);
      const settings = menu.items.find((item) => item.label === "Project Settings…");
      if (settings) {
        Menu.buildFromTemplate = build;
        menu.popup = (options) => {
          settings.click(settings, options!.window!, { triggeredByAccelerator: false });
          options?.callback?.();
        };
      }
      return menu;
    };
  });
  await page
    .getByRole("navigation", { name: "Projects and global utilities" })
    .getByRole("button", { name })
    .click({ button: "right" });
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
}

/** Creates an unsent Session through the Sessions accessory destination picker. */
export async function createSessionInProject(page: Page, name: RegExp) {
  await showSessions(page);
  await page
    .getByRole("region", { name: "Sessions", exact: true })
    .getByRole("button", { name: "New Session", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "New session", exact: true })
    .getByRole("option", { name })
    .click();
}

/** Opens the real exclusive Sessions accessory without changing the focused conversation. */
export async function showSessions(page: Page) {
  const back = page.getByRole("button", { name: "Back to chat", exact: true });
  if (await back.isVisible()) await back.click();
  const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
  await expect(rail).toBeVisible({ timeout: 20_000 });
  const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
  if (!(await workspace.isVisible())) {
    await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
  }
  await workspace.getByRole("button", { name: /^Sessions / }).click();
  return workspace;
}
