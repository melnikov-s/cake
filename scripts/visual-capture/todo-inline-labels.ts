import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

const title = "Improve project navigation";
const custom = "Navigation polish";
const startup = "Investigate slow project startup and repeated configuration reads";

export function createTodoInlineLabelsScenario(
  seed: VisualCaptureScenario["seed"],
): VisualCaptureScenario {
  return {
    name: "todo-inline-labels",
    description:
      "Inline conversation heading label tooltip, keyboard completion, restore and required-session blocker",
    states: ["label-hover", "restore-hover"],
    async seed(paths, theme) {
      const dispose = await seed(paths, theme);
      const file = join(paths.cakeHome, "state", "application.json");
      const application = JSON.parse(await readFile(file, "utf8"));
      application.data.globalSessionLabels.push({
        id: "10000000-0000-4000-8000-000000000001",
        name: custom,
        color: "violet",
      });
      // Exercise actual human Done with and without required work in the same transcript.
      const [blocked, standalone] = application.data.projects[0].todos.items;
      blocked.associations = [
        { kind: "session", sessionId: "visual-missing-required", title: "Missing required work" },
      ];
      standalone.associations = [];
      await writeFile(file, JSON.stringify(application));
      return dispose;
    },
    async prepare(page, state) {
      await page
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click();
      const composer = page.getByRole("combobox", { name: "Message Project Chat" });
      await expect(composer).toBeVisible();
      // Leave the expanded dynamic project rail before moving to the outdented heading.
      await composer.click();
      await expect(page.locator('[data-slot="project-rail"]')).toHaveAttribute(
        "data-expanded",
        "false",
      );
      const transcript = page.locator(".transcript").last();
      const headings = transcript.locator('[data-slot="task-section-label"]');
      const blocked = headings
        .filter({
          has: page.getByRole("button", { name: `Show in To-do: ${startup}`, exact: true }),
        })
        .first();
      const blockedDone = blocked.getByRole("button", {
        name: `Mark done: ${startup}`,
        exact: true,
      });
      await blockedDone.press("Enter");
      const error = page.getByText(/Cannot complete to-do:.*visual-missing-required/);
      await expect(error.first()).toBeVisible();
      await expect(blockedDone).toBeEnabled();
      await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();

      const heading = headings.filter({
        has: page.getByRole("button", { name: `Show in To-do: ${title}`, exact: true }),
      });
      const completion = heading.getByRole("button", { name: `Mark done: ${title}`, exact: true });
      const restore = heading.getByRole("button", { name: `Reopen: ${title}`, exact: true });
      const label = (name: string) =>
        heading.getByRole("button", {
          name: `Change label for ${title}. Current label: ${name}`,
          exact: true,
        });
      await label("Unlabelled").scrollIntoViewIfNeeded();
      await label("Unlabelled").press("Enter");
      // Only the menu opens on the left; the to-do stays open.
      await expect(restore).toHaveCount(0);
      const menu = page.getByRole("menu", { name: "Choose label" });
      await expect(menu).toBeVisible();
      await label("Unlabelled").press("ArrowDown");
      await expect(menu.getByRole("menuitemradio").first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(menu.getByRole("menuitemradio", { name: custom, exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(label(custom)).toHaveAttribute("aria-expanded", "false");
      await expect(label(custom)).toBeFocused();
      await expect(completion).toHaveCSS("opacity", "1");
      const [labelBox, actionBox, headingBox] = await Promise.all([
        label(custom).boundingBox(),
        completion.boundingBox(),
        heading.boundingBox(),
      ]);
      expect(labelBox!.x + labelBox!.width).toBeLessThan(actionBox!.x);
      expect(actionBox!.x + actionBox!.width).toBeCloseTo(headingBox!.x + headingBox!.width, 0);
      await completion.press("Enter");
      await expect(restore).toBeVisible();
      if (state === "label-hover") {
        await restore.press("Enter");
        await expect(completion).toBeEnabled();
        await label(custom).hover();
        await expect(page.getByRole("tooltip", { name: custom, exact: true })).toBeVisible();
      } else {
        await restore.hover();
        await expect(
          page.getByRole("tooltip", { name: `Reopen: ${title}`, exact: true }),
        ).toBeVisible();
      }
      await expect(label(custom).locator("[data-session-label-color]")).toHaveCount(1);
    },
    // Label tooltips portal outside the conversation pane; don't crop them at its edge.
    region: (page) => page.locator("body"),
  };
}
