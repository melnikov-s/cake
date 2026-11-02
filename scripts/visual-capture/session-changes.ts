import { expect, type Page } from "@playwright/test";
import { seedSessionChanges } from "../../tests/fixtures/session-changes";

export const sessionChangesScenario = {
  name: "session-changes",
  description: "Session commit badge and Changes accessory pane backed by real Git history",
  states: ["closed", "open", "expanded"],
  async seed(
    paths: { project: string; cakeHome: string; userData: string },
    theme: "light" | "dark",
  ) {
    await seedSessionChanges(paths, theme);
  },
  async prepare(page: Page, state: string) {
    const toggle = page.getByRole("button", { name: "Review changes · 3 commits", exact: true });
    await expect(toggle).toBeVisible();
    if (state !== "closed") {
      await toggle.click();
      const panel = page.getByRole("complementary", { name: "Changes", exact: true });
      await expect(panel.getByText("agent/changes-review", { exact: true })).toBeVisible();
      await expect(panel.getByRole("region", { name: "Staged", exact: true })).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Refresh changes", exact: true }),
      ).toBeEnabled();
      if (state === "expanded")
        await panel
          .getByRole("button", { name: /Show commit history in the changes pane/ })
          .click();
    }
    await page.mouse.move(1, 1);
  },
  region: (page: Page) => page.locator("body"),
};
