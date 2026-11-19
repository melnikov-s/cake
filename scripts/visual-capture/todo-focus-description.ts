import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

const title = "Investigate slow project startup and repeated configuration reads";
const intro = "Find the startup bottleneck and recommend a focused fix.";

export function createTodoFocusDescriptionScenario(
  seed: VisualCaptureScenario["seed"],
): VisualCaptureScenario {
  return {
    name: "todo-focus-description",
    description: "Labeled to-do with its original status dot, inline details and Focus row action",
    states: ["collapsed", "expanded", "focus-hover", "global-expanded"],
    async seed(paths, theme) {
      const dispose = await seed(paths, theme);
      const file = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(file, "utf8"));
      const labelId = "10000000-0000-4000-8000-000000000001";
      application.data.globalSessionLabels.push({ id: labelId, name: "Research", color: "violet" });
      const item = application.data.projects[0].todos.items[0];
      item.labelId = labelId;
      item.description = `${intro}\n\nCompare two cold launches with a warm launch. Record the repeated reads and check whether caching still picks up edits to the project config.`;
      await writeFile(file, JSON.stringify(application));
      return dispose;
    },
    async prepare(page, state) {
      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      if (state !== "global-expanded") {
        await page
          .getByRole("button", { name: /^Open Project Chat for / })
          .first()
          .click();
        await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
      }
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      if (!(await workspace.isVisible()))
        await page.locator('[data-slot="shell-workspace-toggle"]').click();
      if (!(await workspace.getByRole("searchbox", { name: "Search to-dos" }).isVisible()))
        await workspace.getByRole("button", { name: /^To-dos / }).click();
      const disclosure = workspace.getByRole("button", { name: title, exact: true });
      const row = disclosure.locator("..");
      const preview = row.getByText(intro, { exact: false });
      const status = row.locator('[data-slot="nav-trailing"] [role="img"]');
      const marker = await status.getAttribute("aria-label");
      const focus = row.getByRole("button", { name: `Focus to-do: ${title}`, exact: true });
      const report = row.getByRole("link", { name: "Exact investigation report", exact: true });
      await expect(status).toBeVisible();
      await expect(row.getByText("Research", { exact: true })).toBeVisible();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(preview).toHaveCSS("-webkit-line-clamp", "2");
      await expect(report).toHaveCount(0);
      await disclosure.hover();
      await expect(focus).toHaveCSS("opacity", "1");
      await expect(page.getByRole("tooltip").filter({ hasText: intro })).toHaveCount(0);
      if (state === "focus-hover") {
        await page.mouse.move(1, 1);
        await focus.hover();
        await expect.poll(() => focus.evaluate((element) => element.matches(":hover"))).toBe(true);
        await expect(page.getByRole("tooltip").filter({ hasText: "Focus to-do:" })).toHaveText(
          `Focus to-do: ${title}`,
        );
      } else if (state === "expanded" || state === "global-expanded") {
        await preview.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        await expect(preview).toHaveCSS("-webkit-line-clamp", "none");
        await expect(report).toBeVisible();
        await expect(row.getByText(/Report delivered; awaiting your review/)).toBeVisible();
        await expect(status).toHaveAttribute("aria-label", marker!);
        await preview.hover();
      }
      await expect(focus).toHaveAttribute("aria-pressed", "false");
      await page.waitForFunction(() => document.fonts.status === "loaded");
    },
    region: (page, state) =>
      state === "focus-hover"
        ? page.locator("body")
        : page.getByRole("complementary", { name: "Workspace", exact: true }),
  };
}
