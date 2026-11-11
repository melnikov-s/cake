import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { projectSetupScenario } from "../../scripts/visual-capture/project-setup";

for (const theme of ["light", "dark"] as const) {
  test(`Projects header retains its Add project target across disclosure in ${theme}`, async () => {
    test.setTimeout(120_000);
    const temporary = await mkdtemp(join(tmpdir(), "cake-rail-add-project-"));
    const paths = {
      cakeHome: join(temporary, "cake-home"),
      project: join(temporary, "project"),
      userData: join(temporary, "user-data"),
    };
    await projectSetupScenario.seed(paths, theme);
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
      // Count calls at the native picker boundary; never open an OS dialog.
      await application.evaluate(({ dialog }) => {
        process.env.CAKE_TEST_ADD_PROJECT_CALLS = "0";
        dialog.showOpenDialog = async () => {
          process.env.CAKE_TEST_ADD_PROJECT_CALLS = String(
            Number(process.env.CAKE_TEST_ADD_PROJECT_CALLS) + 1,
          );
          return { canceled: true, filePaths: [] };
        };
      });
      const page = await application.firstWindow();
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      const project = rail.getByRole("button", {
        name: "Open Project Chat for Atlas",
        exact: true,
      });
      await expect(project).toBeVisible({ timeout: 20_000 });
      await project.click();
      const composer = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
      await expect(composer).toBeVisible();
      await composer.focus();
      await page.mouse.move(500, 250);
      await expect.poll(async () => (await rail.boundingBox())!.width).toBe(54);
      const heading = rail.locator('[data-slot="navigation-rail-section"]');
      const add = heading.getByRole("button", { name: "Add project", exact: true });
      await expect(heading.getByRole("button")).toHaveCount(1);
      await expect(add.locator("button, a, [tabindex]")).toHaveCount(0);
      const glyph = await add.locator("svg").evaluate((svg) => svg.outerHTML);
      const compactIcon = (await add.locator("svg").boundingBox())!;
      const originalPoint = {
        x: compactIcon.x + compactIcon.width / 2,
        y: compactIcon.y + compactIcon.height / 2,
      };
      const captures = resolve(repositoryRoot, ".visual-captures");
      await mkdir(captures, { recursive: true });
      await page.screenshot({
        path: join(captures, `projects-header-compact-${theme}.png`),
        clip: { x: 0, y: 0, width: 300, height: 260 },
      });

      await page.mouse.move(originalPoint.x, originalPoint.y);
      await expect(rail).toHaveAttribute("data-expanded", "true");
      await expect.poll(async () => (await rail.boundingBox())!.width).toBe(240);
      expect(await add.locator("svg").evaluate((svg) => svg.outerHTML)).toBe(glyph);
      const bounds = (await add.boundingBox())!;
      expect(bounds.y + bounds.height / 2).toBe(originalPoint.y);
      expect(bounds.height).toBe(28);
      const points = [
        originalPoint,
        { x: bounds.x + 55, y: originalPoint.y }, // label
        { x: bounds.x + 130, y: originalPoint.y }, // blank space
        { x: bounds.x + bounds.width - 18, y: originalPoint.y }, // trailing icon
      ];
      await page.screenshot({
        path: join(captures, `projects-header-expanded-${theme}.png`),
        clip: { x: 0, y: 0, width: 300, height: 260 },
      });
      let calls = 0;
      const expectOneCall = async () => {
        calls += 1;
        await expect
          .poll(() => application.evaluate(() => Number(process.env.CAKE_TEST_ADD_PROJECT_CALLS)))
          .toBe(calls);
        await expect(project).toHaveAttribute("aria-current", "page");
      };
      for (const point of points) {
        // Verify actual hit testing, not a synthetic click on the button locator.
        expect(
          await add.evaluate(
            (button, position) =>
              document.elementFromPoint(position.x, position.y)?.closest("button") === button,
            point,
          ),
        ).toBe(true);
        await page.mouse.click(point.x, point.y);
        await expectOneCall();
      }
      // Plain Tab is Cake's writing shortcut; reverse traversal remains native.
      await rail.getByRole("region", { name: "Projects", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(add).toBeFocused();
      await expect(add).toHaveAccessibleName("Add project");
      await page.keyboard.press("Enter");
      await expectOneCall();
      await page.keyboard.press("Space");
      await expectOneCall();

      // Non-hover input can activate the compact control without first disclosing labels.
      // Choosing a folder intentionally opens the empty workbench, even on cancel.
      // Restore Project Chat before using its composer to release rail focus.
      await project.click();
      await expect(composer).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
      await composer.focus();
      await page.mouse.move(500, 250);
      await expect(rail).toHaveAttribute("data-labels-visible", "false");
      await expect.poll(async () => (await rail.boundingBox())!.width).toBe(54);
      // Non-hover mode adds a disclosure control above the actions, so measure anew.
      const nonHoverIcon = (await add.locator("svg").boundingBox())!;
      await page.mouse.click(
        nonHoverIcon.x + nonHoverIcon.width / 2,
        nonHoverIcon.y + nonHoverIcon.height / 2,
      );
      await expectOneCall();
      await cdp.detach();
      const windows = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      );
      expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
    } finally {
      await application.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
