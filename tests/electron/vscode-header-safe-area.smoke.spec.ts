import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";

async function headerGeometry(page: Page) {
  return page.locator('[data-slot="workspace-header"]').evaluate((header) => {
    const title = header.querySelector('[data-slot="workspace-title"]')!;
    const titleBounds = title.getBoundingClientRect();
    const mode = header.querySelector('[data-slot="workspace-mode"]')!.getBoundingClientRect();
    const drag = document
      .querySelector('[data-slot="window-controls-drag-region"]')!
      .getBoundingClientRect();
    const buttons = [...header.querySelectorAll<HTMLButtonElement>("button")];
    return {
      left: header.getBoundingClientRect().left,
      padding: Number.parseFloat(getComputedStyle(header).paddingLeft),
      titleLeft: titleBounds.left,
      titleRight: titleBounds.right,
      modeLeft: mode.left,
      dragRight: drag.right,
      dragWidth: drag.width,
      overflow: document.documentElement.scrollWidth > innerWidth,
      buttonsSafe: buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        // Breadcrumbs scroll inside their clipped title slot at narrow widths.
        return title.contains(button)
          ? Math.max(rect.left, titleBounds.left) >= drag.right &&
              Math.min(rect.right, titleBounds.right) <= innerWidth
          : rect.left >= drag.right && rect.right <= innerWidth;
      }),
    };
  });
}

test("VS Code header clears native controls through mode, rail and narrow-window transitions", async () => {
  test.skip(
    !existsSync("/opt/homebrew/bin/code-server"),
    "Requires a local code-server installation",
  );
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-vscode-header-"));
  const paths = {
    cakeHome: join(temporary, "cake-home"),
    project: join(temporary, "project"),
    userData: join(temporary, "user-data"),
  };
  const projectName = "Cake with a long breadcrumb label for narrow windows";
  const timestamp = new Date(0).toISOString();
  await Promise.all(
    [paths.project, paths.userData, join(paths.cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(paths.cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      vscodeServerPath: "/opt/homebrew/bin/code-server",
      projects: [
        { path: paths.project, name: projectName, addedAt: timestamp, lastOpenedAt: timestamp },
      ],
    }),
  );
  const repository = resolve(import.meta.dirname, "../..");
  const application = await electron.launch({
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
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 800),
    );
    await expect(page.locator('[data-slot="workspace-header"]')).toBeVisible();
    await page
      .getByRole("button", { name: `Open Project Chat for ${projectName}`, exact: true })
      .click();
    const main = await headerGeometry(page);
    expect(main.padding).toBe(46);
    await page.getByRole("button", { name: "VS Code", exact: true }).click();
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.titleBar))
      .toBe("vscode");
    await expect
      .poll(
        () =>
          application.evaluate(async ({ webContents }) => {
            for (const contents of webContents.getAllWebContents()) {
              if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
              if (
                await contents.executeJavaScript(
                  'Boolean(document.querySelector(".monaco-workbench"))',
                )
              )
                return true;
            }
            return false;
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
    const rail = page.locator('[data-slot="project-rail"]');
    await expect(rail).toHaveAttribute("data-auto-hide", "true");
    const nativeMac = process.platform === "darwin";
    const verify = async () => {
      const geometry = await headerGeometry(page);
      expect(geometry.padding).toBe(nativeMac ? 100 : 46);
      expect(geometry.titleLeft).toBe(nativeMac ? 100 : 46);
      expect(geometry.titleRight).toBeLessThanOrEqual(geometry.modeLeft);
      expect(geometry.overflow).toBe(false);
      if (nativeMac) expect(geometry.buttonsSafe).toBe(true);
      return geometry;
    };
    const hidden = await verify();
    if (nativeMac) {
      const lights = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
      );
      expect(lights).not.toBeNull();
      expect(hidden.titleLeft).toBeGreaterThan(lights!.x + 2 * 23 + 14);
    }
    const breadcrumb = page.getByRole("navigation", { name: "Conversation breadcrumb" });
    const home = breadcrumb.getByRole("button").first();
    await expect(home).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(page.locator('[data-slot="workspace-header"]')).toHaveCSS(
      "-webkit-app-region",
      "drag",
    );
    await expect(page.locator('[data-slot="workspace-mode"]')).toHaveCSS(
      "-webkit-app-region",
      "no-drag",
    );
    await page.mouse.move(1, 200);
    await expect(rail).toHaveAttribute("data-revealed", "true");
    expect(await verify()).toEqual(hidden);
    await home.hover();
    await expect(rail).toHaveAttribute("data-revealed", "false");
    await verify();
    for (const width of [760, 1100]) {
      await application.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 800),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await verify();
    }
    const screenshot = test.info().outputPath("vscode-header.png");
    await page.screenshot({ path: screenshot });
    await test.info().attach("vscode-header", { path: screenshot, contentType: "image/png" });
    await page.getByRole("button", { name: "Main", exact: true }).click();
    await expect.poll(async () => (await headerGeometry(page)).left).toBe(main.left);
    expect((await headerGeometry(page)).padding).toBe(46);
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    expect((await headerGeometry(page)).padding).toBe(46);
    await page.getByRole("button", { name: "VS Code", exact: true }).click();
    await expect.poll(async () => (await headerGeometry(page)).left).toBe(0);
    await verify();
    if (nativeMac) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "display-mode", value: "fullscreen" }],
      });
      const fullscreenMedia = await page.evaluate(
        () => matchMedia("(display-mode: fullscreen)").matches,
      );
      test.info().annotations.push({
        type: "fullscreen-media-emulated",
        description: String(fullscreenMedia),
      });
      if (fullscreenMedia) {
        const fullscreen = await headerGeometry(page);
        expect(fullscreen.padding).toBe(46);
        expect(fullscreen.dragWidth).toBe(0);
      } else {
        test.info().annotations.push({
          type: "coverage-limit",
          description:
            "Chromium cannot emulate fullscreen display-mode here; native fullscreen transitions are not exercised by this hidden smoke.",
        });
      }
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
      await cdp.detach();
      await verify();
    }
    // Real pointer activation must remain possible outside the native drag strip.
    await home.click();
    const windows = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    );
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
  } catch (error) {
    const page = await application.firstWindow();
    const screenshot = test.info().outputPath("failure-ui.png");
    await page.screenshot({ path: screenshot });
    await test.info().attach("failure-ui", { path: screenshot, contentType: "image/png" });
    await test.info().attach("failure-dom", {
      body: await page.locator("body").innerHTML(),
      contentType: "text/html",
    });
    throw error;
  } finally {
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
