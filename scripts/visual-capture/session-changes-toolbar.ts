import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { seedSessionChanges } from "../../tests/fixtures/session-changes";
import type { VisualCaptureScenario } from "./scenarios";

/** Real Git counts exercise both double digits and the capped display in toolbar context. */
export function createSessionChangesToolbarScenario(count: number): VisualCaptureScenario {
  return {
    name: `session-changes-toolbar-${count}`,
    description: "Readable Changes icon and count without overlap, at the shared toolbar height",
    states: ["default", "open"],
    async seed(paths, theme) {
      const { worktree } = await seedSessionChanges(paths, theme);
      for (let index = 3; index < count; index++)
        await promisify(execFile)(
          "git",
          ["commit", "--allow-empty", "-m", `Toolbar count fixture ${index + 1}`],
          { cwd: worktree },
        );
    },
    async prepare(page, state) {
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      const search = page.getByRole("dialog", { name: "Search sessions", exact: true });
      await search.getByRole("combobox", { name: "Search session titles" }).fill("Review changes");
      await search.getByRole("option").filter({ hasText: "Review changes" }).click();
      const toggle = page.getByRole("button", {
        name: `Review changes · ${count} commits`,
        exact: true,
      });
      await expect(toggle).toBeVisible();
      await expect(toggle.locator('[data-slot="count-badge"]')).toHaveText(
        count > 99 ? "99+" : String(count),
      );
      const geometry = await toggle.evaluate((button) => {
        const badge = button.querySelector('[data-slot="count-badge"]')!;
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        const b = badge.getBoundingClientRect();
        const t = button.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(badge);
        const digits = text.getBoundingClientRect();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const luminance = (color: string) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
        };
        const contrast = (first: string, second: string) => {
          const a = luminance(first);
          const b = luminance(second);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        return {
          countContrast: contrast(
            getComputedStyle(badge).color,
            getComputedStyle(badge).backgroundColor,
          ),
          iconContrast: contrast(
            getComputedStyle(button).color,
            getComputedStyle(document.documentElement).getPropertyValue("--background"),
          ),
          neighborsSeparated: [
            ...button.closest('[data-slot="workspace-header"]')!.querySelectorAll("button"),
          ].every((neighbor) => {
            if (neighbor === button) return true;
            const n = neighbor.getBoundingClientRect();
            return (
              n.width === 0 ||
              n.height === 0 ||
              n.right <= t.left ||
              n.left >= t.right ||
              n.bottom <= t.top ||
              n.top >= t.bottom
            );
          }),
          height: t.height,
          width: t.width,
          fontSize: getComputedStyle(badge).fontSize,
          fontWeight: getComputedStyle(badge).fontWeight,
          foreground: getComputedStyle(button).color,
          countForeground: getComputedStyle(badge).color,
          background: getComputedStyle(badge).backgroundColor,
          gap: b.left - icon.right,
          centered: Math.abs(icon.y + icon.height / 2 - (b.y + b.height / 2)) < 1,
          contained:
            b.right <= t.right && icon.left >= t.left && b.top >= t.top && b.bottom <= t.bottom,
          textFits:
            digits.left >= b.left &&
            digits.right <= b.right &&
            digits.top >= b.top &&
            digits.bottom <= b.bottom,
          iconSize: [icon.width, icon.height],
        };
      });
      console.log("CHANGES_TOOLBAR_GEOMETRY", JSON.stringify(geometry));
      expect(geometry.countContrast).toBeGreaterThanOrEqual(4.5);
      expect(geometry.iconContrast).toBeGreaterThanOrEqual(3);
      expect(geometry.neighborsSeparated).toBe(true);
      expect(geometry.height).toBe(28);
      expect(geometry.width).toBeLessThanOrEqual(72);
      expect(geometry.fontSize).toBe("14px");
      expect(geometry.fontWeight).toBe("600");
      expect(geometry.countForeground).toBe(geometry.foreground);
      expect(geometry.countForeground).not.toBe(geometry.background);
      expect(geometry.gap).toBeGreaterThanOrEqual(4);
      expect(geometry.centered).toBe(true);
      expect(geometry.contained).toBe(true);
      expect(geometry.textFits).toBe(true);
      expect(geometry.iconSize).toEqual([18, 18]);
      if (state === "open") {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await expect(
          page.getByRole("complementary", { name: "Changes", exact: true }),
        ).toBeVisible();
      }
      await page.mouse.move(1, 1);
    },
    region: (page) => page.locator('[data-slot="workspace-header"]'),
  };
}
