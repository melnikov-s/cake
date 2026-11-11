import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { createSessionOutcomesScenario } from "../../scripts/visual-capture/session-outcomes";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`session links reveal on their own card or row hover and keyboard focus (${theme})`, async ({}, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-link-hover-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = createSessionOutcomesScenario();
    await scenario.seed(paths, theme);
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      // Exclude transcript entrance motion from the hover layout measurements.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 1000),
      );
      await scenario.prepare(page, "default");
      const batch = page.getByRole("status", { name: "Session results" });
      const card = batch.locator('[data-slot="session-message-card"]');
      const sourceLink = card.getByRole("link", { name: "Open source" });
      const disclosure = card.getByRole("button", { name: "Worker findings stay readable" });
      const rows = batch.locator('[data-slot="session-system-update"]');
      const rowLinks = rows.getByRole("link", { name: "Open session", exact: true });
      await expect(rows).toHaveCount(4);
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");

      for (const link of [sourceLink, ...(await rowLinks.all())]) {
        await expect(link).toHaveCSS("opacity", "0");
      }
      const cardBounds = await card.boundingBox();
      const rowBounds = await rows.nth(1).boundingBox();
      const sourceBounds = await sourceLink.boundingBox();
      const rowLinkBounds = await rowLinks.nth(1).boundingBox();
      await batch.screenshot({ path: testInfo.outputPath(`links-rest-${theme}.png`) });

      await card.hover();
      await expect(sourceLink).toHaveCSS("opacity", "1");
      for (const link of await rowLinks.all()) await expect(link).toHaveCSS("opacity", "0");
      expect(await card.boundingBox()).toEqual(cardBounds);
      expect(await sourceLink.boundingBox()).toEqual(sourceBounds);
      await batch.screenshot({ path: testInfo.outputPath(`links-card-hover-${theme}.png`) });

      // Every system-update variant has its own hover scope, including merged/resolved.
      for (let index = 0; index < 4; index++) {
        await rows.nth(index).hover();
        await expect(sourceLink).toHaveCSS("opacity", "0");
        for (let other = 0; other < 4; other++) {
          await expect(rowLinks.nth(other)).toHaveCSS("opacity", index === other ? "1" : "0");
        }
      }
      await rows.nth(1).hover({ position: { x: 1, y: 18 } });
      await expect(rowLinks.nth(1)).toHaveCSS("opacity", "1");
      expect(await rows.nth(1).boundingBox()).toEqual(rowBounds);
      expect(await rowLinks.nth(1).boundingBox()).toEqual(rowLinkBounds);
      await batch.screenshot({ path: testInfo.outputPath(`links-row-hover-${theme}.png`) });

      await page.mouse.move(1, 1);
      await disclosure.focus();
      await expect(sourceLink).toHaveCSS("opacity", "1");
      // Cake reserves plain Tab for the composer; Shift+Tab retains control traversal.
      await sourceLink.focus();
      await expect(sourceLink).toBeFocused();
      await expect(sourceLink).toHaveCSS("opacity", "1");
      await sourceLink.press("Shift+Tab");
      await expect(disclosure).toBeFocused();
      await sourceLink.focus();
      await sourceLink.press("Enter");
      await expect(page.getByRole("heading", { name: "Original findings" })).toBeVisible();

      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).first().click();
      const rowTitle = rows.nth(1).getByRole("link", {
        name: "Exclude Project Chat from working-session count",
      });
      await rowTitle.focus();
      await expect(rowLinks.nth(1)).toHaveCSS("opacity", "1");
      await rowLinks.nth(1).focus();
      await expect(rowLinks.nth(1)).toBeFocused();
      await expect(rowLinks.nth(1)).toHaveCSS("opacity", "1");
      await rowLinks.nth(1).press("Shift+Tab");
      await expect(rowTitle).toBeFocused();
      await rowLinks.nth(1).focus();
      await rowLinks.nth(1).press("Enter");
      await expect(page.locator('[data-slot="workspace-title"] [aria-current="page"]')).toHaveText(
        "Successful report source",
      );

      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).first().click();
      await page.getByRole("combobox", { name: "Message Cake Chat", exact: true }).focus();
      await page.mouse.move(1, 1);
      await expect(sourceLink).toHaveCSS("opacity", "0");
      await expect(rowLinks.nth(1)).toHaveCSS("opacity", "0");
      // Pointer activation still navigates without toggling the card.
      await sourceLink.click();
      await expect(page.getByRole("heading", { name: "Original findings" })).toBeVisible();
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
