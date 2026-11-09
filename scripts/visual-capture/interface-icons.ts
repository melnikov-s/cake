import { expect, type Locator } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

async function expectGlyph(control: Locator, size: number) {
  await expect(control).toBeVisible();
  const geometry = await control.evaluate((element) => {
    const svg = element.querySelector("svg")!;
    const icon = svg.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    return {
      width: icon.width,
      height: icon.height,
      contained:
        icon.left >= target.left &&
        icon.right <= target.right &&
        icon.top >= target.top &&
        icon.bottom <= target.bottom,
      onScreen:
        icon.left >= 0 && icon.right <= innerWidth && icon.top >= 0 && icon.bottom <= innerHeight,
    };
  });
  expect(geometry).toEqual({ width: size, height: size, contained: true, onScreen: true });
}

/** Real chrome and compact to-dos share a window, but not an icon scale. */
export function createInterfaceIconsScenario(todos: VisualCaptureScenario): VisualCaptureScenario {
  return {
    name: "interface-icons",
    description: "24px application controls alongside 12px to-do glyphs and unchanged status dots",
    states: ["todos", "sessions", "terminal"],
    seed: todos.seed,
    async prepare(page, state) {
      await todos.prepare(page, "hover");
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      if ((await page.evaluate(() => innerWidth)) < 1000) {
        // Exercise the real minimum-width accessory, not a CSS-only mock.
        const resize = page.getByRole("separator", { name: "Resize Workspace", exact: true });
        await resize.focus();
        await page.keyboard.press("Home");
        await resize.blur();
        await expect(workspace).toHaveCSS("width", "240px");
      }
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      for (const name of [
        "Add project",
        "New session",
        "Search sessions",
        "Artifacts",
        "Automations",
        "Settings",
      ]) {
        await expectGlyph(rail.getByRole("button", { name, exact: true }), 24);
      }
      for (const name of ["Main", "VS Code", "Browser", "Terminal", "Close Workspace"]) {
        await expectGlyph(page.getByRole("button", { name, exact: true }), 24);
      }
      const header = page.locator('[data-slot="workspace-header"]');
      await expectGlyph(header.getByRole("button", { name: /^\d+ artifacts$/ }), 24);

      if (state === "terminal") {
        await page.getByRole("button", { name: "Terminal", exact: true }).click();
        const terminal = page.locator('section[aria-label="Terminal"]');
        await expect(terminal).toHaveAttribute("aria-hidden", "false");
        await expect(terminal.locator(".xterm-screen:visible")).toBeVisible();
        // Wait for the slide-in before checking screen bounds.
        await expect.poll(async () => (await terminal.boundingBox())!.y).toBeGreaterThanOrEqual(0);
        for (const name of ["New terminal tab", "Pin terminal to bottom", "Hide terminal"]) {
          await expectGlyph(terminal.getByRole("button", { name, exact: true }), 24);
        }
        await terminal.getByRole("button", { name: "Pin terminal to bottom" }).click();
        await expectGlyph(terminal.getByRole("button", { name: "Move terminal to top" }), 24);
      } else if (state === "sessions") {
        await workspace.getByRole("button", { name: /^Sessions ·/ }).click();
        await expect(workspace.locator("[data-navigation-item]").first()).toBeVisible();
        expect(
          await workspace.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      } else {
        const row = page.locator('[data-todo-id="00000000-0000-4000-8000-000000000011"]');
        await row.hover();
        for (const name of [
          "Mark done: Startup investigation",
          "Attach to-do as context: Startup investigation",
          "Unfocus to-do: Startup investigation",
        ]) {
          const control = row.getByRole("button", { name, exact: true });
          await expectGlyph(control, 12);
          const target = await control.boundingBox();
          expect(target!.width).toBeGreaterThanOrEqual(20);
          expect(target!.height).toBeGreaterThanOrEqual(20);
        }
        const glyphs = row.locator("ul li > span > span > svg");
        expect(await glyphs.count()).toBeGreaterThan(0);
        for (const glyph of await glyphs.all()) {
          const box = await glyph.boundingBox();
          expect(box!.width).toBe(12);
          expect(box!.height).toBe(12);
        }
        await expectGlyph(workspace.getByRole("button", { name: "Active (1)", exact: true }), 12);
        await expectGlyph(page.getByRole("button", { name: "Clear to-do focus", exact: true }), 12);
        const dot = page.getByRole("img", { name: "Ready for review", exact: true });
        const dotBox = await dot.boundingBox();
        expect(dotBox!.width).toBe(8);
        expect(dotBox!.height).toBe(8);
        for (const item of await workspace.locator("[data-todo-id]").all()) {
          const geometry = await item.evaluate((element) => {
            const title = element.querySelector("button[aria-pressed]")!.getBoundingClientRect();
            const actions = element
              .querySelector('[data-slot="todo-actions"]')!
              .getBoundingClientRect();
            const done = element
              .querySelector('[data-slot="nav-trailing"]')!
              .getBoundingClientRect();
            return {
              separated: done.right <= title.left && title.right <= actions.left,
              fits: element.scrollWidth <= element.clientWidth,
            };
          });
          expect(geometry).toEqual({ separated: true, fits: true });
        }
        // Leave the same hovered row as the pre-change capture for comparison.
        await page.locator('[data-todo-id="00000000-0000-4000-8000-000000000012"]').hover();
      }
    },
    region: (page) => page.locator("body"),
  };
}
