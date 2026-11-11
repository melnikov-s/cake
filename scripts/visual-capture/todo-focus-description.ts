import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

const title = "Investigate slow project startup and repeated configuration reads";

/** Entering to-do focus leaves the description closed; real pointer travel opens it. */
export function createTodoFocusDescriptionScenario(
  seed: VisualCaptureScenario["seed"],
): VisualCaptureScenario {
  return {
    name: "todo-focus-description",
    description: "To-do focus opens without its description; hovering the pane row shows it",
    states: ["entered", "hover"],
    seed,
    async prepare(page, state) {
      await page
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click();
      const composer = page.getByRole("combobox", { name: "Message Project Chat" });
      await expect(composer).toBeVisible();
      await composer.click();
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      if (!(await workspace.isVisible()))
        await page.locator('[data-slot="shell-workspace-toggle"]').click();
      await workspace.getByRole("button", { name: /^To-dos / }).click();
      const row = workspace.getByRole("button", { name: title, exact: true });
      await expect(row).toHaveAttribute("aria-pressed", "false");
      const pane = page.locator('[data-slot="session-pane"]');
      const transcript = pane.locator(".transcript").last();
      await transcript.evaluate((element) => {
        element.scrollTop = 0;
      });
      // Enter from the transcript: the pane row is programmatically focused, and the
      // filtered transcript moves under the resting pointer.
      await transcript
        .getByRole("button", { name: `Focus to-do: ${title}`, exact: true })
        .first()
        .click();
      await expect(pane.getByRole("button", { name: "Clear to-do focus" })).toBeVisible();
      await expect(row).toHaveAttribute("aria-pressed", "true");
      await expect(row).toBeFocused();
      const description = page
        .getByRole("tooltip")
        .filter({ hasText: "Find the startup bottleneck and recommend a focused fix." });
      await page.waitForTimeout(500);
      await expect(description).toHaveCount(0);
      await page.waitForFunction(() => document.fonts.status === "loaded");
      if (state === "hover") {
        await row.hover({ position: { x: 24, y: 10 } });
        await expect(description).toBeVisible();
      } else {
        await page.mouse.move(1, 1);
        await page.waitForTimeout(300);
        await expect(description).toHaveCount(0);
      }
    },
    region: (page) => page.locator('[data-slot="side-chat-layout"]'),
  };
}
