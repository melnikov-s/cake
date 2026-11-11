import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

const longTitle =
  "Deep consultant review of Cake architecture and APIs, including navigation, workspace controls and session ownership";
const shortTitle = "Review";

/** Real header layout and hit targets; only the isolated transcript titles are synthetic. */
export function createSessionHeaderTitleScenario(
  base: VisualCaptureScenario,
): VisualCaptureScenario {
  return {
    name: "session-header-title",
    description:
      "Single-line breadcrumb ellipsis without scrollbars, with usable adjacent controls",
    states: ["long-title", "short-title"],
    async seed(paths, theme) {
      const cleanup = await base.seed(paths, theme);
      const directory = join(
        paths.cakeHome,
        "pi",
        "sessions",
        `--${paths.project.replace(/^\//, "").replace(/\//g, "-")}--`,
      );
      const originalId = "visual-assistant-markdown-code";
      const originalFile = join(directory, `1970-01-01T00-00-00-000Z_${originalId}.jsonl`);
      const original = await readFile(originalFile, "utf8");
      for (const [id, title] of [
        [originalId, longTitle],
        ["visual-short-header-title", shortTitle],
      ] as const) {
        await writeFile(
          join(directory, `1970-01-01T00-00-00-000Z_${id}.jsonl`),
          original.replace(originalId, id) +
            JSON.stringify({
              type: "session_info",
              id: "header-title",
              parentId: "assistant-1",
              timestamp: new Date(0).toISOString(),
              name: title,
            }) +
            "\n",
        );
      }
      return cleanup;
    },
    async prepare(page, state) {
      const title = state === "short-title" ? shortTitle : longTitle;
      const openSession = async () => {
        await page.getByRole("button", { name: "Search sessions", exact: true }).first().click();
        await page.keyboard.type(title);
        await page
          .getByRole("option", { name: new RegExp(title) })
          .first()
          .click();
      };
      await page
        .getByRole("button", { name: "Open Project Chat for visual-capture-project", exact: true })
        .click();
      await openSession();
      const breadcrumb = page.getByRole("navigation", { name: "Conversation breadcrumb" });
      const current = breadcrumb.getByRole("button", { name: title, exact: true });
      await expect(current).toHaveAttribute("aria-current", "page");
      await expect(current).toHaveAttribute("title", title);
      await page.waitForFunction(() => document.fonts.status === "loaded");

      const geometry = await current.evaluate((button) => {
        const label = button.querySelector("span")!;
        const nav = button.closest("nav")!;
        const labelStyle = getComputedStyle(label);
        const navStyle = getComputedStyle(nav);
        const modes = document.querySelector('[data-slot="workspace-mode"]')!;
        return {
          labelWidth: label.clientWidth,
          labelScrollWidth: label.scrollWidth,
          textOverflow: labelStyle.textOverflow,
          whiteSpace: labelStyle.whiteSpace,
          labelOverflow: labelStyle.overflow,
          navOverflowX: navStyle.overflowX,
          navOverflowY: navStyle.overflowY,
          navExtraWidth: nav.scrollWidth - nav.clientWidth,
          navExtraHeight: nav.scrollHeight - nav.clientHeight,
          beforeModes: nav.getBoundingClientRect().right <= modes.getBoundingClientRect().left,
        };
      });
      expect(geometry.labelWidth).toBeGreaterThan(20);
      expect(geometry.textOverflow).toBe("ellipsis");
      expect(geometry.whiteSpace).toBe("nowrap");
      expect(geometry.labelOverflow).toBe("hidden");
      expect(geometry.navOverflowX).toBe("hidden");
      expect(geometry.navOverflowY).toBe("hidden");
      expect(geometry.navExtraWidth).toBeLessThanOrEqual(1);
      expect(geometry.navExtraHeight).toBeLessThanOrEqual(1);
      expect(geometry.beforeModes).toBe(true);
      if (state === "long-title")
        expect(geometry.labelScrollWidth).toBeGreaterThan(geometry.labelWidth);
      else expect(geometry.labelScrollWidth).toBe(geometry.labelWidth);

      // Trial clicks prove real hit targets aren't covered by the title.
      for (const name of ["Main", "VS Code", "Browser", "0 artifacts"])
        await page.getByRole("button", { name, exact: true }).click({ trial: true });
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Browser address" })).toBeVisible();
      await page.getByRole("button", { name: "Main", exact: true }).click();
      await expect(current).toBeVisible();
      // Project navigation still works, and the same session can be reopened.
      await breadcrumb.getByRole("button", { name: "visual-capture-project", exact: true }).click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      await openSession();
      await expect(current).toBeVisible();
      await page.mouse.move(1, 100);
      console.log("SESSION_HEADER_TITLE_GEOMETRY", JSON.stringify({ state, ...geometry }));
    },
    region: (page) => page.locator('[data-slot="workspace-header"]'),
  };
}
