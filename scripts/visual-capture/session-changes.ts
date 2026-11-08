import { expect, type Page } from "@playwright/test";
import {
  seedSessionChanges,
  sessionChangesComparisonBranch,
} from "../../tests/fixtures/session-changes";

export const sessionChangesScenario = {
  name: "session-changes",
  description: "Session commit badge and Changes accessory pane backed by real Git history",
  states: [
    "closed",
    "open",
    "expanded",
    "sessions",
    "todos",
    "compare",
    "compare-hover",
    "compare-focus",
    "compare-long",
  ],
  async seed(
    paths: { project: string; cakeHome: string; userData: string },
    theme: "light" | "dark",
  ) {
    await seedSessionChanges(paths, theme);
  },
  async prepare(page: Page, state: string) {
    await page.getByRole("button", { name: "Search sessions", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search sessions", exact: true });
    await search.getByRole("combobox", { name: "Search session titles" }).fill("Review changes");
    await search.getByRole("option").filter({ hasText: "Review changes" }).click();
    if (state === "sessions" || state === "todos") {
      await page
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click();
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      if (!(await workspace.isVisible()))
        await page.getByRole("button", { name: "To-do", exact: true }).click();
      await workspace
        .getByRole("button", { name: state === "sessions" ? /^Sessions / : /^To-dos / })
        .click();
      await expect(
        workspace.getByRole("img", { name: "3 commits, +4 −1", exact: true }),
      ).toBeVisible();
      await expect(workspace.getByText("Worktree commit history", { exact: true })).toHaveCount(0);
      if (state === "sessions") {
        const line = workspace.locator(
          '[data-session-id="session-changes-review"] [data-slot="session-description"]',
        );
        const centers = await line.evaluate((element) =>
          Array.from(
            element.querySelectorAll(
              'time, [data-slot="commit-change-stats"], [data-slot="session-worktree"]',
            ),
          ).map((child) => {
            const rect = child.getBoundingClientRect();
            return rect.y + rect.height / 2;
          }),
        );
        expect(centers).toHaveLength(3);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
      }
      await page.mouse.move(1, 1);
      return;
    }
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
      if (state.startsWith("compare")) {
        const picker = panel.getByRole("combobox", { name: "Compare with" });
        await picker.selectOption(
          state === "compare-long" ? sessionChangesComparisonBranch : "main",
        );
        await expect(picker).toHaveValue(
          state === "compare-long" ? sessionChangesComparisonBranch : "main",
        );
        if (state === "compare-hover") {
          await picker.hover();
          return;
        }
        if (state === "compare-focus") {
          await page.keyboard.press("Shift");
          await picker.focus();
          await expect(picker).toBeFocused();
          return;
        }
      }
      if (state === "expanded")
        await panel
          .getByRole("button", { name: /Show commit history in the changes pane/ })
          .click();
    }
    await page.mouse.move(1, 1);
  },
  region: (page: Page, state: string) =>
    state.startsWith("compare")
      ? page.getByRole("complementary", { name: "Changes", exact: true })
      : page.locator("body"),
};
