import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../src/contracts/application/application-data.ts";
import { windowState } from "../../tests/fixtures/window-state.ts";
import { openProjectSettings } from "../../tests/electron/fixtures/workspace-navigation.ts";
import type { VisualCaptureScenario } from "./scenarios.ts";

/** Real native-picker boundary and dialogs; no model requests or user data. */
export const projectSetupScenario: VisualCaptureScenario = {
  name: "project-setup",
  description: "Folder-first project setup, matching settings, and the icon model menu",
  states: ["default", "model-menu", "settings", "external-settings"],
  async seed(paths, theme) {
    await Promise.all([
      mkdir(paths.userData, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(join(paths.cakeHome, "..", "Atlas"), { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowState({ project: paths.project, theme }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            {
              path: paths.project,
              name: "Atlas",
              addedAt: new Date(0).toISOString(),
              lastOpenedAt: new Date(0).toISOString(),
              settings: defaultProjectSettings(),
            },
          ],
        },
      }),
    );
  },
  async prepare(page, state, application) {
    if (!application) throw new Error("Project setup requires isolated Electron");
    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    await expect(rail).toBeVisible({ timeout: 20_000 });
    if (state === "settings" || state === "external-settings") {
      await openProjectSettings(application, page, /^Open Project Chat for Atlas$/);
      await expect(page.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue(
        "Atlas",
      );
      await expect(page.getByText("Registered folder can’t be changed here.")).toBeVisible();
      if (state === "external-settings") {
        await page.getByRole("radio", { name: "Merge outside Cake", exact: true }).check();
        await page
          .getByRole("dialog", { name: "Atlas settings", exact: true })
          .locator("form > .overflow-y-auto")
          .evaluate((element) => {
            element.scrollTop = 0;
          });
      }
    } else {
      const cakeHome = await application.evaluate(() => process.env.CAKE_HOME);
      if (!cakeHome) throw new Error("Missing isolated Cake home");
      await application.evaluate(
        ({ dialog }, path) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
        },
        join(cakeHome, "..", "Atlas"),
      );
      await rail.getByRole("button", { name: "Add project", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Add project", exact: true })).toBeVisible();
      const name = page.getByRole("textbox", { name: "Project name", exact: true });
      await expect(name).toHaveValue("Atlas");
      await expect(name).toBeFocused();
      await expect(
        page
          .getByRole("dialog", { name: "Add project", exact: true })
          .getByRole("button", { name: "Add project", exact: true }),
      ).toBeEnabled();
      if (state === "model-menu") {
        const arrow = page.getByRole("button", { name: "Icon generation model", exact: true });
        await arrow.focus();
        await arrow.press("Enter");
        await expect(page.getByRole("radio", { name: "Utility model", exact: true })).toBeChecked();
        await page.keyboard.press("Escape");
        await expect(page.getByText("Current: Utility model", { exact: true })).toBeHidden();
        await expect(page.getByRole("dialog", { name: "Add project", exact: true })).toBeVisible();
        await arrow.press("Enter");
        await expect(page.getByText("Current: Utility model", { exact: true })).toBeVisible();
      }
    }
    await expect(
      page.getByRole("radio", {
        name: state === "external-settings" ? "Merge outside Cake" : "Merge with Cake",
        exact: true,
      }),
    ).toBeChecked();
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page
      .getByRole("dialog", { name: /^(Add project|Atlas settings)$/ })
      .evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        );
      });
    await page.mouse.move(1, 1);
  },
  region: (page) => page.getByRole("dialog", { name: /^(Add project|Atlas settings)$/ }),
};
