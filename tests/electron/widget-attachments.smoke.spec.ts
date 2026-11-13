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
      await page.screenshot({
        scale: "css",
        path: testInfo.outputPath(`widgets-four-slots-${theme}.png`),
      });
      // Paired preferred sizes must allocate deterministically when the window is narrower/shorter.
      for (const [width, height, first, second, axis] of [
        [850, 1000, "left", "right", "width"],
        [1440, 280, "top", "bottom", "height"],
      ] as const) {
        await app.evaluate(
          ({ BrowserWindow }, { width, height }) => {
            const window = BrowserWindow.getAllWindows()[0]!;
            window.setMinimumSize(0, 0);
            window.setContentSize(width, height);
          },
          { width, height },
        );
        await expect
          .poll(async () =>
            Number(
              await page
                .getByRole("separator", { name: `Resize ${first} widgets`, exact: true })
                .getAttribute("aria-valuenow"),
            ),
          )
          .toBeLessThan(first === "left" ? 280 : 160);
        const samples = await page.evaluate(
          async ({ first, second, axis }) => {
            const result = [];
            for (let frame = 0; frame < 20; frame++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              result.push(
                [first, second].map(
                  (slot) =>
                    document.querySelector(`[data-widget-slot="${slot}"]`)!.getBoundingClientRect()[
                      axis
                    ],
                ),
              );
            }
            return result;
          },
          { first, second, axis },
        );
        for (const sample of samples) {
          expect(sample[0]).toBeCloseTo(sample[1]!, 1);
          expect(sample).toEqual(samples[0]);
        }
      }
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000),
      );
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await composer.click();
      await expect(composer).toBeFocused();
      await composer.fill("The conversation remains usable");
      await expect(composer).toHaveValue("The conversation remains usable");
      const oldFrame = await left.locator("iframe").elementHandle();
      await left.getByRole("button", { name: "Move Shared dashboard", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-widget-slot="left"]')).toHaveCount(0);
      await expect(
        left.locator("iframe").contentFrame().getByText("Shared count: 1"),
      ).toBeVisible();
      expect(await oldFrame!.evaluate((element) => element.isConnected)).toBe(false);
      // Drag within a populated slot replaces the obsolete Up/Down controls.
      const header = left.getByRole("button", { name: "Move Shared dashboard", exact: true });
      const headerBounds = (await header.boundingBox())!;
      await page.mouse.move(headerBounds.x + 20, headerBounds.y + headerBounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(headerBounds.x + 28, headerBounds.y + headerBounds.height / 2);
      const firstSibling = (await page
        .locator('[data-widget-attachment="dashboard-right"]')
        .boundingBox())!;
      const chatBounds = (await page.locator("[data-widget-chat]").boundingBox())!;
      await page.mouse.move(
        firstSibling.x + firstSibling.width / 2,
        Math.max(firstSibling.y + 10, chatBounds.y + chatBounds.height / 4 + 10),
        {
          steps: 8,
        },
      );
      await page.mouse.up();
      await expect
        .poll(async () =>
          page
            .locator('[data-widget-slot="right"] [data-widget-attachment]')
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-widget-attachment")),
            ),
        )
        .toEqual(["dashboard-left", "dashboard-right"]);
      await expect(page.locator("[data-widget-placement-overlay]")).toHaveCount(0);
      await left
        .getByRole("button", { name: "Widget options for Shared dashboard", exact: true })
        .click();
      await page.getByRole("button", { name: "Hide", exact: true }).click();
      await expect(left.locator("iframe")).toHaveCount(0);
      await page.getByRole("button", { name: "Show", exact: true }).click();
      await page.keyboard.press("Escape");
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
      await page.screenshot({
        scale: "css",
        path: testInfo.outputPath(`widget-crash-${theme}.png`),
      });
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
