import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`session search supports keyboard, selection, resolved sessions and project focus (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-search-"));
    const paths = {
      userData: join(root, "user-data"),
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
    };
    const scenario = findVisualCaptureScenario("session-search")!;
    await scenario.seed(paths, theme);
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
      await scenario.prepare(page, "sidebar");
      const trigger = page.getByRole("button", { name: "Search sessions", exact: true });
      const dialog = page.getByRole("dialog", { name: "Search sessions", exact: true });
      const filter = dialog.getByRole("combobox", { name: "Search session titles" });
      const message = page.getByRole("combobox", { name: "Message", exact: true });
      await trigger.click();
      await expect(filter).toBeFocused();
      await expect(dialog.getByRole("listbox", { name: "Sessions", exact: true })).toBeVisible();
      await expect(dialog.getByRole("option")).toHaveCount(4);
      await message.evaluate((element: HTMLElement) => element.focus());
      await expect(filter).toBeFocused();
      await page.keyboard.type("srch dlg");
      await expect(filter).toHaveValue("srch dlg");
      await expect(dialog.getByRole("option")).toHaveCount(1);
      await expect(dialog.getByRole("option", { selected: true })).toContainText(
        "Search dialog keyboard",
      );
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(filter).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await expect(message).toBeFocused();
      await expect(page.locator('[data-slot="workspace-header"]')).toContainText(
        "Search dialog keyboard",
      );
      await page.keyboard.type("A retained search-session draft");
      await expect(message).toHaveValue("A retained search-session draft");

      const selectedRow = page.locator(
        '[data-slot="sidebar"] [data-session-id="visual-session-search-1"]',
      );
      await selectedRow.locator(".session-resolve-action").click();
      await trigger.click();
      await page.keyboard.type("search dialog");
      await expect(dialog.getByRole("option")).toHaveCount(1);
      await expect(dialog.getByRole("img", { name: "Resolved session" })).toBeVisible();
      await dialog.getByRole("option").click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId("resolved-session-notice")).toBeVisible();

      await page.getByRole("button", { name: "Focus on project", exact: true }).click();
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(dialog).toContainText("Search sessions in Cake by title.");
      await expect(filter).toHaveValue("");
      await expect(dialog.getByRole("option")).toHaveCount(3);
      await page.keyboard.type("website");
      await expect(dialog.getByRole("status")).toHaveText("No matching sessions.");
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await page.getByRole("button", { name: "Exit focus mode for project" }).click();
      await trigger.click();
      await expect(filter).toHaveValue("");
      await page.keyboard.type("website");
      await expect(dialog.getByRole("option")).toContainText("Website search");
      await filter.fill("");
      await page.keyboard.press("ArrowDown");
      await expect(filter).toBeFocused();
      const activeOption = dialog.getByRole("option", { selected: true });
      await expect(activeOption).toHaveCount(1);
      const activeId = await filter.getAttribute("aria-activedescendant");
      await dialog.getByRole("option").first().hover();
      await expect(filter).toHaveAttribute("aria-activedescendant", activeId!);
      await expect(activeOption).toHaveAttribute("id", activeId!);
      await expect(dialog.locator(".session-item")).toHaveCount(4);
      await expect(dialog.locator(".session-item").first().locator("time")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
