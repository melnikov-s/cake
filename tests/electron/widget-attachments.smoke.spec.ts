import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { widgetAttachmentsScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const)
  test(`shared widget views, placement, saved state and crash isolation (${theme})`, async ({}, testInfo) => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-widget-attachments-"));
    const paths = {
      project: join(root, "project"),
      cakeHome: join(root, "cake-home"),
      userData: join(root, "user-data"),
    };
    await widgetAttachmentsScenario.seed(paths, theme);
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000),
      );
      await widgetAttachmentsScenario.prepare?.(page, "default", app);
      const left = page.locator('[data-widget-attachment="dashboard-left"]');
      const frame = left.locator("iframe").contentFrame();
      await expect(frame.locator("output")).toHaveText("Structured JSON: object");
      await frame.getByRole("button", { name: "Save count" }).click();
      for (const slot of ["top", "bottom", "left", "right"]) {
        const widget = page
          .locator(`[data-widget-attachment="dashboard-${slot}"] iframe`)
          .contentFrame();
        await expect(widget.getByText("Shared count: 1")).toBeVisible();
        await expect(widget.getByText("Current session: visual-widget-attachments")).toBeVisible();
      }
      const homeBounds = await page
        .getByRole("navigation", { name: "Session home" })
        .getByRole("button")
        .boundingBox();
      const titleBounds = await page
        .locator('[data-widget-attachment="dashboard-top"]')
        .getByText("Shared dashboard", { exact: true })
        .boundingBox();
      expect(homeBounds).not.toBeNull();
      expect(titleBounds).not.toBeNull();
      expect(titleBounds!.x).toBeGreaterThanOrEqual(homeBounds!.x + homeBounds!.width);
      await page.screenshot({ path: testInfo.outputPath(`widgets-four-slots-${theme}.png`) });
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await composer.click();
      await expect(composer).toBeFocused();
      await composer.fill("The conversation remains usable");
      await expect(composer).toHaveValue("The conversation remains usable");
      const oldFrame = await left.locator("iframe").elementHandle();
      await left
        .getByRole("button", { name: "Widget options for Shared dashboard", exact: true })
        .click();
      await page.getByLabel("Move Shared dashboard", { exact: true }).selectOption("right");
      await expect(page.locator('[data-widget-slot="left"]')).toHaveCount(0);
      await expect(
        left.locator("iframe").contentFrame().getByText("Shared count: 1"),
      ).toBeVisible();
      expect(await oldFrame!.evaluate((element) => element.isConnected)).toBe(false);
      await left.getByRole("button", { name: "Hide", exact: true }).click();
      await expect(left.locator("iframe")).toHaveCount(0);
      await left.getByRole("button", { name: "Show", exact: true }).click();
      await expect(
        left.locator("iframe").contentFrame().getByText("Shared count: 1"),
      ).toBeVisible();
      await left
        .locator("iframe")
        .contentFrame()
        .getByRole("button", { name: "Crash widget" })
        .click();
      await expect(left.getByText("Widget stopped")).toBeVisible();
      await expect(left.locator("iframe")).toHaveCount(0);
      await expect(left.getByRole("button", { name: "Repair", exact: true })).toBeVisible();
      await expect(
        page
          .locator('[data-widget-attachment="dashboard-top"] iframe')
          .contentFrame()
          .getByText("Shared count: 1"),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`widget-crash-${theme}.png`) });
      await left.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(
        left.locator("iframe").contentFrame().getByText("Shared count: 1"),
      ).toBeVisible();
      await expect(composer).toHaveValue("The conversation remains usable");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
