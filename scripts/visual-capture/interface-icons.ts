import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
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
      computed: [getComputedStyle(svg).width, getComputedStyle(svg).height],
      contained:
        icon.left >= target.left &&
        icon.right <= target.right &&
        icon.top >= target.top &&
        icon.bottom <= target.bottom,
      onScreen:
        icon.left >= 0 && icon.right <= innerWidth && icon.top >= 0 && icon.bottom <= innerHeight,
    };
  });
  expect(geometry).toEqual({
    width: size,
    height: size,
    computed: [`${size}px`, `${size}px`],
    contained: true,
    onScreen: true,
  });
}

/** Real chrome and compact to-dos share a window, with explicit role-based glyph boxes. */
export function createInterfaceIconsScenario(
  todos: VisualCaptureScenario,
  seedChat: (
    directory: string,
    texts: readonly string[],
    taskIds?: readonly (string | null)[],
  ) => Promise<void>,
): VisualCaptureScenario {
  return {
    name: "interface-icons",
    description:
      "24px view switches, 18px shell navigation and 12px inline actions; unchanged targets/status dots",
    states: ["todos", "sessions", "terminal", "actions"],
    async seed(paths, theme) {
      await todos.seed(paths, theme);
      const hash = createHash("sha256").update(paths.project).digest("hex");
      await seedChat(
        join(paths.cakeHome, "pi", "project-chats", hash),
        [
          "Review the startup investigation.",
          "The startup review is ready.",
          "Keep the navigation consistent.",
        ],
        ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000011"],
      );
    },
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
      expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      const cake = rail.getByRole("button", { name: "Open Cake Chat", exact: true });
      await expectGlyph(cake, 18);
      const cakeGeometry = await cake.locator("svg").evaluate((svg: SVGSVGElement) => {
        const painted = svg.getBBox();
        return {
          viewBox: svg.getAttribute("viewBox"),
          width: painted.width,
          height: painted.height,
          inside:
            painted.x >= 0 &&
            painted.y >= 0 &&
            painted.x + painted.width <= 24 &&
            painted.y + painted.height <= 24,
        };
      });
      expect(cakeGeometry.viewBox).toBe("0 0 24 24");
      expect(cakeGeometry.width).toBeGreaterThanOrEqual(16);
      expect(cakeGeometry.height).toBeGreaterThanOrEqual(16);
      expect(cakeGeometry.inside).toBe(true);
      const project = rail.getByRole("button", { name: /^Open Project Chat for / }).first();
      const projectIcon = await project.locator('[data-slot="avatar"] img').boundingBox();
      expect(projectIcon!.width).toBe(18);
      expect(projectIcon!.height).toBe(18);
      expect((await project.boundingBox())!.height).toBe(36);
      const breadcrumbIcon = page
        .getByRole("navigation", { name: "Conversation breadcrumb" })
        .locator('[data-slot="avatar"] img');
      expect(
        await breadcrumbIcon.evaluate((icon) => [
          getComputedStyle(icon).width,
          getComputedStyle(icon).height,
        ]),
      ).toEqual(["18px", "18px"]);
      await expectGlyph(rail.getByRole("button", { name: /^Browser sharing:/ }), 18);
      for (const name of [
        "Add project",
        "New session",
        "Search sessions",
        "Artifacts",
        "Automations",
        "Settings",
      ]) {
        const control = rail.getByRole("button", { name, exact: true });
        await expectGlyph(control, 18);
        expect((await control.boundingBox())!.height).toBe(36);
      }
      for (const name of ["Main", "VS Code", "Browser"]) {
        const control = page.getByRole("button", { name, exact: true });
        await expectGlyph(control, 24);
        expect((await control.boundingBox())!.height).toBe(28);
      }
      for (const name of ["Terminal", "Close Workspace"]) {
        await expectGlyph(page.getByRole("button", { name, exact: true }), 18);
      }
      await expectGlyph(
        page.locator(".workbench-composer").getByRole("button", { name: "Send", exact: true }),
        18,
      );
      const header = page.locator('[data-slot="workspace-header"]');
      await expectGlyph(header.getByRole("button", { name: /^\d+ artifacts$/ }), 18);

      if (state === "terminal") {
        await page.getByRole("button", { name: "Terminal", exact: true }).click();
        const terminal = page.locator('section[aria-label="Terminal"]');
        await expect(terminal).toHaveAttribute("aria-hidden", "false");
        await expect(terminal.locator(".xterm-screen:visible")).toBeVisible();
        // Wait for the slide-in before checking screen bounds.
        await expect.poll(async () => (await terminal.boundingBox())!.y).toBeGreaterThanOrEqual(0);
        for (const name of ["New terminal tab", "Pin terminal to bottom", "Hide terminal"]) {
          await expectGlyph(terminal.getByRole("button", { name, exact: true }), 18);
        }
        await terminal.getByRole("button", { name: "Pin terminal to bottom" }).click();
        await expectGlyph(terminal.getByRole("button", { name: "Move terminal to top" }), 18);
      } else if (state === "actions") {
        // Focus filters out fixture responses without an attribution; actions exercise the full chat.
        await page.getByRole("button", { name: "Clear to-do focus", exact: true }).click();
        const copy = page.getByRole("button", { name: "Copy response", exact: true }).first();
        await copy.locator("xpath=ancestor::article").hover();
        for (const control of [
          copy,
          page.getByRole("button", { name: "Reply to message", exact: true }).first(),
        ]) {
          await expectGlyph(control, 12);
          expect((await control.boundingBox())!.height).toBe(28);
        }
        const input = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
        await input.fill("");
        await input.click();
        await page.keyboard.type("Check the icon hierarchy.");
        await expect(input).toBeFocused();
        expect(
          await input.evaluate((element) =>
            element instanceof HTMLTextAreaElement ? element.value : element.textContent,
          ),
        ).toBe("Check the icon hierarchy.");
        await expect(
          page.locator(".workbench-composer").getByRole("button", { name: "Send", exact: true }),
        ).toBeEnabled();
        const reply = page.getByRole("button", { name: "Reply to message", exact: true }).first();
        await reply.click();
        await expect(input).toBeFocused();
        await expectGlyph(
          page.getByRole("button", { name: "Remove Reply to message", exact: true }),
          12,
        );
        await workspace
          .getByRole("button", {
            name: "Attach to-do as context: Improve project navigation",
            exact: true,
          })
          .click();
        await expectGlyph(
          page.getByRole("button", {
            name: "Remove To-do · Improve project navigation",
            exact: true,
          }),
          12,
        );
        await copy.locator("xpath=ancestor::article").hover();
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

/** Exercise the real activity-bar toggle without changing its ownership/persistence. */
export function createAutoMergeIconsScenario(
  activity: VisualCaptureScenario,
  startSession: (page: Page, title: string) => Promise<void>,
): VisualCaptureScenario {
  return {
    name: "interface-icons-auto-merge",
    description: "12px Auto-merge in the real activity/worktree composer cap",
    states: ["default"],
    seed: activity.seed,
    async prepare(page) {
      // Use search rather than assuming the startup selection or an open Sessions accessory.
      await startSession(page, "fix-x");
      await page.getByRole("button", { name: "Search sessions", exact: true }).click();
      const search = page.getByRole("dialog", { name: "Search sessions", exact: true });
      await search
        .getByRole("combobox", { name: "Search session titles" })
        .fill("How should agents");
      await search.getByRole("option").first().click();
      const toggle = page.getByRole("button", { name: "Auto-merge: off", exact: true });
      await expectGlyph(toggle, 12);
      expect((await toggle.boundingBox())!.height).toBe(28);
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      const copy = page.getByRole("button", { name: "Copy response", exact: true }).first();
      await copy.locator("xpath=ancestor::article").hover();
      await expectGlyph(copy, 12);
    },
    region: (page) => page.locator("body"),
  };
}
