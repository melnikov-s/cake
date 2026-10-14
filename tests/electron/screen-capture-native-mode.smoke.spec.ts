import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("@foreground screenshot capture preserves macOS foreground process mode", async () => {
  test.skip(
    process.platform !== "darwin" || process.env.CAKE_ELECTRON_FOREGROUND_TESTS !== "1",
    "Native macOS activation-policy checks require explicit desktop-focus opt-in.",
  );
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-capture-native-mode-"));
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const userData = join(temporaryRoot, "user-data");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "dark" }));
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "Capture regression",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [project],
    }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await application.evaluate(
      ({
        app,
        BrowserWindow,
        desktopCapturer,
        nativeImage,
        screen,
        systemPreferences,
        globalShortcut,
      }) => {
        // Never capture the user's desktop or register a real global shortcut.
        const image = nativeImage.createFromBitmap(Buffer.alloc(600 * 400 * 4, 255), {
          width: 600,
          height: 400,
        });
        desktopCapturer.getSources = async () => [
          {
            id: "screen:fixture",
            name: "Fixture display",
            display_id: String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),
            thumbnail: image,
            appIcon: null,
          },
        ];
        systemPreferences.getMediaAccessStatus = () => "granted";
        globalShortcut.register = () => true;
        globalShortcut.unregister = () => {};
        // Smoke startup intentionally hides the Dock. Only this opted-in test restores
        // regular app mode: dock.isVisible() reads NSRunningApplication.activationPolicy.
        return app.dock!.show().then(() => {
          const owner = BrowserWindow.getAllWindows()[0]!;
          owner.show();
          owner.focus();
        });
      },
    );
    const regularAppMode = () => application.evaluate(({ app }) => app.dock!.isVisible());
    await expect.poll(regularAppMode).toBe(true);
    // Electron ignores DockHide for one second after DockShow. Let that native guard
    // expire so the old capture code cannot accidentally pass this regression.
    await delay(1100);
    await composer.click();
    await page.keyboard.type("Retain this draft");
    const settings = page.getByRole("complementary").getByLabel("Open settings", { exact: true });
    await settings.click();
    await page.getByRole("button", { name: /^Screen Capture/ }).click();
    for (const outcome of ["cancel", "attach", "cancel"] as const) {
      const opened = application.waitForEvent("window");
      await page.getByRole("button", { name: "Capture screenshot", exact: true }).click();
      const overlay = await opened;
      await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
      // The old fullscreen-workspace API changes process mode as soon as the overlay
      // is created, even before it is shown. A macOS panel must leave it unchanged.
      expect(await regularAppMode()).toBe(true);
      const panel = await application.browserWindow(overlay);
      await panel.evaluate((window) => {
        window.show();
        window.focus();
      });
      expect(await regularAppMode()).toBe(true);
      if (outcome === "attach") {
        await overlay.getByRole("button", { name: "Attach full display" }).click();
      } else {
        await overlay.keyboard.press("Escape").catch((error: unknown) => {
          if (!overlay.isClosed()) throw error;
        });
      }
      await expect.poll(() => application.windows().length).toBe(1);
      expect(await regularAppMode()).toBe(true);
      if (outcome === "attach") {
        await expect(page.getByRole("button", { name: /^View Screenshot-/ })).toHaveCount(1);
        await settings.click();
        await page.getByRole("button", { name: /^Screen Capture/ }).click();
      }
    }
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(page.getByRole("button", { name: /^View Screenshot-/ })).toHaveCount(1);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
    await composer.click();
    await page.keyboard.type(" after capture");
    await expect(composer).toHaveValue("Retain this draft after capture");
    await expect(composer).toBeFocused();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
