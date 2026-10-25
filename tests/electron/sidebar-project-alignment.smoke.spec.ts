import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function centerX(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!.x + bounds!.width / 2;
}

async function expectAligned(first: Locator, second: Locator) {
  // Sidebar reopening animates its width; measure again until the layout settles.
  await expect
    .poll(async () => Math.abs((await centerX(first)) - (await centerX(second))))
    .toBeLessThan(1);
}

for (const theme of ["light", "dark"] as const) {
  test(`add project shares the sidebar status axis (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-sidebar-project-alignment-"));
    const paths = {
      userData: join(root, "user-data"),
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
    };
    const scenario = findVisualCaptureScenario("project-chat-sidebar")!;
    await scenario.seed(paths, theme);
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
      await scenario.prepare(page, "selected");
      const sidebar = page.locator('[data-slot="sidebar"]');
      const add = sidebar.getByRole("button", { name: "Add project", exact: true });
      const header = sidebar.locator('[data-slot="project-header"]').first();
      const status = header.locator('[data-slot="project-chat-status"]');
      const unread = sidebar
        .locator('.session-item[data-session-id="visual-sidebar-unread"]')
        .getByRole("img", { name: "Ready, unread" });

      for (const width of [1280, 900]) {
        await application.evaluate(({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(width, 800);
        }, width);
        await expect(unread).toBeVisible();
        await expectAligned(add.locator("svg"), unread);
        await expectAligned(add, unread);
        await expectAligned(status, unread);
        const bounds = await add.boundingBox();
        expect(bounds!.width).toBe(28);
        expect(bounds!.height).toBe(28);

        await header.getByRole("button", { name: /^Collapse / }).click();
        await page.mouse.move(1, 1);
        await expect(status).toHaveCSS("opacity", "1");
        await expectAligned(add.locator("svg"), status);
        await header.getByRole("button", { name: /^Expand / }).click();
        await expect(unread).toBeVisible();

        await sidebar.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await expect(sidebar).toBeHidden();
        await page.locator('[data-slot="header-sidebar-toggle"]').click();
        await expect(sidebar).toBeVisible();
        await expectAligned(add.locator("svg"), unread);
      }

      await add.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(add).toBeFocused();
      await expect(page.getByRole("tooltip")).toHaveText("Add project");

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      const touchBounds = await add.boundingBox();
      expect(touchBounds!.width).toBeGreaterThanOrEqual(44);
      expect(touchBounds!.height).toBeGreaterThanOrEqual(44);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
