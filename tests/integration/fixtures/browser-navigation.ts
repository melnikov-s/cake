import { expect, type Page } from "@playwright/test";

/** Opens the Workspace accessory's Sessions source list through the real shell controls. */
export async function showBrowserSessions(page: Page, options?: { tap?: boolean }) {
  const toggle = page.locator('[data-slot="shell-workspace-toggle"]');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    if (options?.tap) await toggle.tap();
    else await toggle.click();
  }
  const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
  const tab = workspace.getByRole("button", { name: /^Sessions / });
  if (options?.tap) await tab.tap();
  else await tab.click();
  return page.getByRole("region", { name: "Sessions", exact: true });
}

/** Chooses a Project Session from the Sessions source list and waits for it to own the workspace. */
export async function openBrowserSession(
  page: Page,
  sessionId: string,
  options?: { tap?: boolean },
) {
  const sessions = await showBrowserSessions(page, options);
  const row = sessions.locator(`.session-item[data-session-id="${sessionId}"]`).first();
  if (options?.tap) await row.tap();
  else await row.click();
  await expect(page.locator('[data-slot="workspace"]')).toHaveAttribute(
    "data-session-id",
    sessionId,
  );
}
