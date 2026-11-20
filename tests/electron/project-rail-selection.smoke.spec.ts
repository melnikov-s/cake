import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

for (const theme of ["dark", "light"] as const) {
  test(`project selection stays distinct from hover, focus and activity in ${theme} mode`, async () => {
    test.setTimeout(120_000);
    const temporary = await mkdtemp(join(tmpdir(), "cake-rail-selection-"));
    const paths = {
      cakeHome: join(temporary, "cake-home"),
      project: join(temporary, "project"),
      userData: join(temporary, "user-data"),
    };
    const scenario = findVisualCaptureScenario("chat-first-navigation")!;
    const cleanup = await scenario.seed(paths, theme);
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
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
      const page = await application.firstWindow();
      await scenario.prepare(page, "rail-selection", application);
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      const selected = rail.getByRole("button", {
        name: "Open Project Chat for cake",
        exact: true,
      });
      const other = rail.getByRole("button", {
        name: "Open Project Chat for docs-site",
        exact: true,
      });
      const activity = selected.getByRole("img", { name: "Work running in cake", exact: true });
      await expect(selected).toHaveAttribute("aria-current", "page");
      await expect(selected).toBeFocused();
      expect(await selected.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      await expect(selected).toHaveCSS("outline-style", "solid");
      await expect(selected).toHaveCSS("outline-width", "2px");
      await expect(activity).toBeVisible();
      const fill = await selected.evaluate((element) => getComputedStyle(element).backgroundColor);
      const marker = await selected.evaluate((element) => {
        const style = getComputedStyle(element, "::before");
        return {
          width: style.width,
          height: style.height,
          position: style.position,
          color: style.backgroundColor,
          pointerEvents: style.pointerEvents,
        };
      });
      expect(marker).toMatchObject({
        width: "2px",
        // Content rows are 32px tall (fc5d8353); the marker is inset 8px top and bottom.
        height: "16px",
        position: "absolute",
        pointerEvents: "none",
      });
      expect(marker.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(await other.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        fill,
      );
      expect(await other.evaluate((element) => getComputedStyle(element, "::before").content)).toBe(
        "none",
      );
      const bounds = await selected.boundingBox();
      await selected.hover();
      await expect(selected).toHaveCSS("background-color", fill);
      expect(await selected.boundingBox()).toEqual(bounds);
      // Plain Tab is the window's writing shortcut (5ee95d62); Shift+Tab is sequential rail
      // navigation. The previous rail control takes the focus ring; selection keeps its fill.
      await page.keyboard.press("Shift+Tab");
      await expect(selected).not.toBeFocused();
      const previous = rail.locator(":focus-visible");
      await expect(previous).toHaveCount(1);
      await expect(previous).toHaveCSS("outline-style", "solid");
      await expect(selected).toHaveAttribute("aria-current", "page");
      await expect(selected).toHaveCSS("background-color", fill);
      await expect(activity).toBeVisible();

      const workspace = page.locator('[data-slot="workspace"]');
      const workspaceBounds = await workspace.boundingBox();
      await page.getByRole("combobox", { name: "Message Project Chat", exact: true }).click();
      await page.mouse.move(500, 220);
      await expect.poll(async () => (await rail.boundingBox())!.width).toBe(54);
      expect(await workspace.boundingBox()).toEqual(workspaceBounds);
      await expect(selected).toHaveCSS("background-color", fill);
      await expect(activity).toBeVisible();
      const markerBounds = await selected.evaluate((element) => {
        const style = getComputedStyle(element, "::before");
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left + parseFloat(style.left),
          right: bounds.left + parseFloat(style.width),
        };
      });
      expect(markerBounds.left).toBeGreaterThanOrEqual(0);
      expect(markerBounds.right).toBeLessThan((await rail.boundingBox())!.width);

      await other.click();
      await expect(other).toHaveAttribute("aria-current", "page");
      await expect(selected).not.toHaveAttribute("aria-current", "page");
      expect(
        await selected.evaluate((element) => getComputedStyle(element, "::before").content),
      ).toBe("none");
      await expect(activity).toBeVisible();
      const windows = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      );
      expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
    } finally {
      await application.close();
      if (typeof cleanup === "function") await cleanup();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
