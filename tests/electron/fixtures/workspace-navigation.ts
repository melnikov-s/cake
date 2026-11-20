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

/** Creates an unsent Session through the global rail destination picker. */
export async function createSessionInProject(page: Page, name: RegExp) {
  await showSessions(page);
  await page
    .getByRole("navigation", { name: "Projects and global utilities" })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await leaveRail(page);
  await page
    .getByRole("dialog", { name: "New session", exact: true })
    .getByRole("option", { name })
    .click();
}

/**
 * Moves the pointer off the project rail, as a user does after choosing a rail action.
 * The Dynamic rail stays expanded over the conversation while hovered.
 */
async function leaveRail(page: Page) {
  const { width, height } = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  await page.mouse.move(width / 2, height / 2);
}

/**
 * Opens an existing Session through the real Search sessions dialog. Launch always starts in
 * global Cake Chat (startup never restores a saved destination), so seeded Sessions are opened
 * explicitly.
 */
export async function openSession(page: Page, title: string) {
  const trigger = page
    .getByRole("navigation", { name: "Projects and global utilities" })
    .getByRole("button", { name: "Search sessions", exact: true });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await trigger.click();
  await leaveRail(page);
  const dialog = page.getByRole("dialog", { name: "Search sessions", exact: true });
  await dialog.getByRole("combobox", { name: "Search session titles" }).fill(title);
  await dialog
    .getByRole("option", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    .first()
    .click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Opens an existing Session by id from the real Workspace Sessions list. Use for seeded
 * Sessions whose title is not searchable (for example image-only or untitled histories).
 */
export async function openSessionById(page: Page, sessionId: string) {
  const workspace = await showSessions(page);
  await workspace.locator(`.session-item[data-session-id="${sessionId}"] .session-row`).click();
  await expect(
    page.locator(`[data-slot="session-pane"][data-session-id="${sessionId}"]`),
  ).toBeVisible();
  return workspace;
}

/** Opens a resolved Session from the Workspace Sessions list's Resolved sessions group. */
export async function openResolvedSessionById(page: Page, sessionId: string) {
  const workspace = await showSessions(page);
  const group = workspace.getByRole("button", { name: "Resolved sessions", exact: true }).first();
  await expect(group).toBeVisible({ timeout: 20_000 });
  if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
  await workspace.locator(`.session-item[data-session-id="${sessionId}"] .session-row`).click();
  await expect(
    page.locator(`[data-slot="session-pane"][data-session-id="${sessionId}"]`),
  ).toBeVisible();
  return workspace;
}

/** Opens a registered Project's permanent Project Chat from the global rail. */
export async function openProjectChat(page: Page, project: string) {
  const button = page
    .getByRole("navigation", { name: "Projects and global utilities" })
    .getByRole("button", { name: `Open Project Chat for ${project}`, exact: true });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
  await leaveRail(page);
}

/** Opens global Cake Chat from the global rail. */
export async function openCakeChat(page: Page) {
  const button = page
    .getByRole("navigation", { name: "Projects and global utilities" })
    .getByRole("button", { name: "Open Cake Chat", exact: true });
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.click();
}

/** Opens application Settings from the global rail. */
export async function openSettings(page: Page) {
  const settings = page
    .getByRole("navigation", { name: "Projects and global utilities" })
    .getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible({ timeout: 20_000 });
  await settings.click();
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

/** Opens the real exclusive To-dos accessory (chat-first navigation, 582d0fc7) and returns it. */
export async function showTodos(page: Page) {
  const back = page.getByRole("button", { name: "Back to chat", exact: true });
  if (await back.isVisible()) await back.click();
  await expect(page.getByRole("navigation", { name: "Projects and global utilities" })).toBeVisible(
    { timeout: 20_000 },
  );
  const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
  if (!(await workspace.isVisible())) {
    await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
  }
  const todos = workspace.getByRole("button", { name: /^To-dos\b/ });
  if ((await todos.getAttribute("aria-pressed")) !== "true") await todos.click();
  await expect(todos).toHaveAttribute("aria-pressed", "true");
  return workspace;
}

/** In Browser and VS Code modes, To-dos/Sessions share the tool companion pane with Chat. */
export async function showCompanionSessions(page: Page) {
  const strip = page.getByRole("group", { name: "Companion content", exact: true });
  await strip.getByRole("button", { name: "Sessions", exact: true }).click();
  return strip;
}
