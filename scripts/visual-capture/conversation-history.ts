import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";
import { createSessionHeaderTitleScenario } from "./session-header-title";

/** Exercise restored chrome through real selection and keyboard commands, without Store injection. */
export function createConversationHistoryScenario(
  base: VisualCaptureScenario,
): VisualCaptureScenario {
  const titles = createSessionHeaderTitleScenario(base);
  return {
    name: "conversation-history",
    description: "Previous/next visit controls in the conversation header with retained drafts",
    states: ["default", "back"],
    seed: titles.seed,
    async prepare(page, state, application) {
      await titles.prepare(page, "short-title", application);
      // Collapse the dynamic project rail before checking header hit targets.
      await page.mouse.move(500, 80);
      await expect
        .poll(async () => (await page.locator('[data-slot="project-rail"]').boundingBox())?.width)
        .toBe(54);
      const history = page.getByRole("group", { name: "Conversation history", exact: true });
      const back = history.getByRole("button", { name: "Go back in session history" });
      const forward = history.getByRole("button", { name: "Go forward in session history" });
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      const breadcrumb = page.getByRole("navigation", { name: "Conversation breadcrumb" });
      const title = await breadcrumb.textContent();
      await composer.fill("Retained thread draft");
      await expect(back).toBeEnabled();
      await expect(forward).toBeDisabled();
      await back.click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      await expect(forward).toBeEnabled();
      await forward.click();
      await expect(composer).toHaveValue("Retained thread draft");
      await expect(breadcrumb).toHaveText(title!);
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+BracketLeft" : "Alt+ArrowLeft",
      );
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+BracketRight" : "Alt+ArrowRight",
      );
      await expect(composer).toHaveValue("Retained thread draft");
      await expect(breadcrumb).toHaveText(title!);
      await expect(forward).toBeDisabled();
      if (state === "back") {
        await back.click();
        await expect(
          page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
        ).toBeVisible();
        await expect(forward).toBeEnabled();
      }
      const geometry = await history.evaluate((group) => {
        const bounds = group.getBoundingClientRect();
        const header = group.closest("header")!.getBoundingClientRect();
        const title = group.parentElement!.querySelector("nav")!.getBoundingClientRect();
        return {
          insideHeader: bounds.top >= header.top && bounds.bottom <= header.bottom,
          beforeTitle: bounds.right <= title.left,
          buttonSizes: [...group.querySelectorAll("button")].map((button) => {
            const rect = button.getBoundingClientRect();
            return [rect.width, rect.height];
          }),
        };
      });
      expect(geometry.insideHeader).toBe(true);
      expect(geometry.beforeTitle).toBe(true);
      expect(geometry.buttonSizes).toEqual([
        [28, 28],
        [28, 28],
      ]);
      for (const button of await history.getByRole("button").all())
        if (await button.isEnabled()) await button.click({ trial: true });
      await page.mouse.move(500, 80);
      console.log("CONVERSATION_HISTORY_GEOMETRY", JSON.stringify({ state, ...geometry }));
    },
    region: (page) => page.locator("body"),
  };
}
