import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { windowState } from "../fixtures/window-state";
import { createSessionInProject } from "./fixtures/workspace-navigation";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("capture handoff reveals and focuses Chat without leaving Browser or VS Code", async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), "cake-capture-return-"));
  const project = join(root, "project");
  const userData = join(root, "user-data");
  const cakeHome = join(root, "cake-home");
  await Promise.all([
    mkdir(project),
    mkdir(userData),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project }));
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Capture return", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
    }),
  );
  const app = await electron.launch({
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
    // Fake pixels/shortcut registration only; retain native overlay, RPC and renderer routing.
    // Never capture the user's desktop or show/focus a native test window.
    await app.evaluate(
      ({ desktopCapturer, nativeImage, screen, systemPreferences, globalShortcut }) => {
        const image = nativeImage.createFromBitmap(Buffer.alloc(800 * 600 * 4, 255), {
          width: 800,
          height: 600,
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
        globalShortcut.register = (_accelerator, callback) => {
          Reflect.set(globalThis, "returnCaptureShortcut", callback);
          return true;
        };
        globalShortcut.unregister = () => {};
      },
    );
    const page = await app.firstWindow();
    await createSessionInProject(page, /^Capture return/);
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible();
    await composer.fill("Keep this unsent draft");
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, "returnCaptureShortcut")))
      .toBe("function");
    const openCapture = async () => {
      const opened = app.waitForEvent("window");
      await app.evaluate(() => Reflect.get(globalThis, "returnCaptureShortcut")());
      const overlay = await opened;
      await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
      return overlay;
    };
    let overlay = await openCapture();
    await overlay.getByRole("button", { name: "Attach full display", exact: true }).click();
    await expect(composer).toBeFocused();
    const expectedDraft = "Keep this unsent draft";
    const images = page.getByRole("button", { name: /^View [a-z0-9]{3}\.png enlarged$/ });
    await expect(images).toHaveCount(1);
    await images.first().click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    overlay = await openCapture();
    // Opening/canceling capture must not dismiss the captured fullscreen content.
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await overlay.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    overlay = await openCapture();
    await overlay.getByRole("button", { name: "Attach full display", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(composer).toBeFocused();
    await composer.pressSequentially(" Ready to discuss");
    await expect(composer).toHaveValue(`${expectedDraft} Ready to discuss`);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.fill(expectedDraft);
    let attachments = 2;
    for (const mode of ["Browser", "VS Code"] as const) {
      await page
        .getByRole("button", {
          name: mode === "Browser" ? "Browser" : "VS Code",
          exact: true,
        })
        .click();
      const workspace = page.getByRole("region", { name: `${mode} workspace` });
      await expect(workspace).toBeVisible();
      const tabs = page.getByRole("group", { name: "Companion content", exact: true });
      for (const tab of ["Sessions", "Todos", "Chat"] as const) {
        await tabs.getByRole("button", { name: tab, exact: true }).click();
        const opened = app.waitForEvent("window");
        await app.evaluate(() => Reflect.get(globalThis, "returnCaptureShortcut")());
        const overlay = await opened;
        await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
        const closed = overlay.waitForEvent("close");
        await overlay.getByRole("button", { name: "Attach full display", exact: true }).click();
        await closed;
        await expect(workspace).toBeVisible();
        await expect(tabs.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await expect(composer).toBeVisible();
        await expect(composer).toBeFocused();
        await expect(composer).toHaveValue(expectedDraft);
        await expect(
          page.getByRole("button", { name: /^View [a-z0-9]{3}\.png enlarged$/ }),
        ).toHaveCount(++attachments);
      }
    }
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
