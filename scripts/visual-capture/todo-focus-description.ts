import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

const title = "Investigate slow project startup and repeated configuration reads";
const intro = "Find the startup bottleneck and recommend a focused fix.";
const shortTitle = "Fix report-card source names";
const shortUpdate =
  "[#2486609](https://delta.shopify.io/shop/world/pull/2486609) live since 20 Nov 00:55. Fix 1 [#2492393](https://delta.shopify.io/shop/world/pull/2492393) (`ba24be3c`) passed review.";
const renderedShortUpdate =
  "#2486609 live since 20 Nov 00:55. Fix 1 #2492393 (ba24be3c) passed review.";
const legacyUpdate = `${intro}\n\nCompare two cold launches with a warm launch. Record the repeated reads and check whether caching still picks up edits to the project config.\n\nUse the baseline measurements in the investigation report to distinguish a slow launch from a delayed refresh.`;
const isClipped = (element: Element) => element.scrollHeight > element.clientHeight;

export function createTodoFocusDescriptionScenario(
  seed: VisualCaptureScenario["seed"],
): VisualCaptureScenario {
  return {
    name: "todo-focus-description",
    description:
      "Short Markdown and legacy Latest updates with inline expansion, named links and row actions",
    states: [
      "collapsed",
      "expanded",
      "narrow-collapsed",
      "narrow-expanded",
      "focus-hover",
      "global-expanded",
    ],
    async seed(paths, theme) {
      const dispose = await seed(paths, theme);
      const file = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(file, "utf8"));
      const labelId = "10000000-0000-4000-8000-000000000001";
      application.data.globalSessionLabels.push({ id: labelId, name: "Research", color: "violet" });
      const [legacy, short] = application.data.projects[0].todos.items;
      legacy.title = title;
      legacy.labelId = labelId;
      legacy.description = legacyUpdate;
      short.title = shortTitle;
      short.description = shortUpdate;
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
      if (state.startsWith("narrow-")) {
        const resize = page.getByRole("separator", { name: "Resize Workspace", exact: true });
        await resize.press("Home");
        await resize.blur();
        await expect(workspace).toHaveCSS("width", "240px");
      }
      const disclosure = workspace.getByRole("button", { name: title, exact: true });
      const row = disclosure.locator("..");
      const preview = row.locator('[data-slot="todo-description"]');
      const shortDisclosure = workspace.getByRole("button", { name: shortTitle, exact: true });
      const shortPreview = shortDisclosure.locator("..").locator('[data-slot="todo-description"]');
      const status = row.locator('[data-slot="nav-trailing"] [role="img"]');
      const marker = await status.getAttribute("aria-label");
      const focus = row.getByRole("button", { name: `Focus to-do: ${title}`, exact: true });
      const report = row.getByRole("link", { name: "Exact investigation report", exact: true });
      await expect(status).toBeVisible();
      await expect(row.getByText("Research", { exact: true })).toBeVisible();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(preview).toHaveCount(1);
      await expect(preview).toHaveCSS(
        "-webkit-line-clamp",
        state.startsWith("narrow-") ? "5" : "4",
      );
      await expect.poll(() => preview.evaluate(isClipped)).toBe(true);
      await expect(shortPreview).toHaveText(renderedShortUpdate);
      await expect(shortPreview.getByRole("link", { name: "#2486609", exact: true })).toBeVisible();
      await expect(shortPreview.locator("code")).toHaveText("ba24be3c");
      await expect.poll(() => shortPreview.evaluate(isClipped)).toBe(false);
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
      } else {
        if (state.endsWith("expanded")) {
          await shortDisclosure.click();
          await expect(shortDisclosure).toHaveAttribute("aria-expanded", "true");
          await preview.click();
          await expect(disclosure).toHaveAttribute("aria-expanded", "true");
          await expect(preview).toHaveCount(1);
          await expect(preview.locator("p")).toHaveCount(3);
          await expect.poll(() => preview.evaluate(isClipped)).toBe(false);
          await expect(report).toBeVisible();
          await expect(row.getByText(/Report delivered; awaiting your review/)).toHaveCount(0);
          await expect(status).toHaveAttribute("aria-label", marker!);
        }
        await page
          .getByRole("combobox", {
            name: state === "global-expanded" ? "Message Cake Chat" : "Message Project Chat",
          })
          .focus();
        await page.mouse.move(1, 1);
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
