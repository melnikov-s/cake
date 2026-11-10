import { expect } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

/** Response inclusion proof, independent of the task-rail geometry assertions. */
export function createTodoResponseFocusScenario(
  seed: VisualCaptureScenario["seed"],
): VisualCaptureScenario {
  return {
    name: "todo-response-focus",
    description: "Focused to-do includes its human question and answering assistant prose",
    states: ["default"],
    seed,
    async prepare(page) {
      await page
        .getByRole("button", { name: /^Open Project Chat for / })
        .first()
        .click();
      const composer = page.getByRole("combobox", { name: "Message Project Chat" });
      await expect(composer).toBeVisible();
      // Move keyboard ownership away from the project rail before using pane controls.
      await composer.click();
      const pane = page.locator('[data-slot="session-pane"]');
      const todos = page.getByRole("complementary", { name: "Workspace" });
      await todos.getByRole("button", { name: /^To-dos / }).click();
      await todos
        .getByRole("button", {
          name: "Investigate slow project startup and repeated configuration reads",
          exact: true,
        })
        .click();
      await expect(pane.getByRole("button", { name: "Clear to-do focus" })).toBeVisible();
      const transcript = pane.locator(".transcript").last();
      await transcript.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(
        transcript.getByText("Investigate slow project startup.", { exact: true }),
      ).toBeVisible();
      await expect(
        transcript.getByText("I’ll trace project loading and compare the slow steps.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(transcript.getByText("The command menu.", { exact: true })).toHaveCount(0);
      await expect(
        transcript.getByText("Separately, improve project navigation.", { exact: true }),
      ).toHaveCount(0);
      await page.mouse.move(800, 40);
    },
    region: (page) => page.locator('[data-slot="session-pane"]'),
  };
}
