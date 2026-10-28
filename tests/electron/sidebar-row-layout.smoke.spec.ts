import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

for (const theme of ["light", "dark"] as const) {
  test(`sidebar labels fill their columns without hover jumps (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-sidebar-row-layout-"));
    const paths = {
      userData: join(root, "user-data"),
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
    };
    const scenario = findVisualCaptureScenario("sidebar-row-layout")!;
    await scenario.seed(paths, theme);
    const app = await electron.launch({
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
      const page = await app.firstWindow();
      await scenario.prepare(page, "narrow");
      const sidebar = page.locator('[data-slot="sidebar"]');
      const header = sidebar.locator('[data-slot="project-header"]').first();
      const label = header.locator('[data-slot="project-label"]');
      const actions = header.locator('[data-slot="project-actions"]');
      const parent = sidebar.locator('.session-item[data-family-role="parent"]');
      const child = sidebar.locator('.session-item[data-family-role="child"]');
      const resize = page.getByRole("separator", { name: "Resize project sidebar", exact: true });
      const measurements = [];
      for (const width of [220, 380]) {
        if (width === 380) {
          await resize.focus();
          for (let step = 0; step < 10; step++) await page.keyboard.press("ArrowRight");
        }
        await expect.poll(async () => (await bounds(sidebar)).width).toBe(width);
        await page.getByRole("combobox", { name: "Message", exact: true }).first().click();
        await page.mouse.move(1, 1);
        await expect(actions).toHaveCSS("opacity", "0");
        const before = await bounds(label);
        const actionBox = await bounds(actions);
        expect(actionBox.width).toBe(48);
        expect(before.width).toBeGreaterThanOrEqual(width - 146);
        expect(actionBox.x - (before.x + before.width)).toBeLessThanOrEqual(4);
        await label.hover();
        await expect(actions).toHaveCSS("opacity", "1");
        expect(await bounds(label)).toEqual(before);
        await header.getByRole("button", { name: /^Project actions for / }).focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("menu", { name: /^Project actions for / })).toBeVisible();
        expect(await bounds(label)).toEqual(before);
        await page.keyboard.press("Escape");
        for (const row of [parent, child]) {
          const title = row.locator(".session-title").locator("..");
          const nav = row.locator(".session-row");
          const trailing = row.locator('[data-slot="nav-trailing"]');
          const initial = await bounds(title);
          expect(initial.width).toBeGreaterThan(width === 220 ? 60 : 220);
          if (await trailing.count()) {
            const trailingBox = await bounds(trailing);
            expect(trailingBox.width).toBe(24);
            expect(trailingBox.x - initial.x - initial.width).toBeLessThanOrEqual(4);
            expect(trailingBox.x + trailingBox.width).toBeLessThanOrEqual(
              (await bounds(nav)).x + (await bounds(nav)).width,
            );
          } else {
            const navBox = await bounds(nav);
            expect(navBox.x + navBox.width - initial.x - initial.width).toBe(8);
          }
          await nav.hover();
          expect(await bounds(title)).toEqual(initial);
          // Pointer activation still selects; disclosure remains a separate control.
          await nav.locator("button").first().click();
          await expect(row).toHaveAttribute("data-navigation-active", "true");
        }
        measurements.push({ width, projectLabel: before.width, actionTrack: actionBox.width });
        await parent.getByRole("button", { name: /^Collapse children/ }).click();
        await expect(child).toBeHidden();
        await parent.getByRole("button", { name: /^Expand children/ }).click();
        await expect(child).toBeVisible();
      }
      await test.info().attach("row-widths", {
        body: JSON.stringify(measurements),
        contentType: "application/json",
      });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
