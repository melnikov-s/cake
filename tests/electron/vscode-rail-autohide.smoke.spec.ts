import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { windowState } from "../fixtures/window-state";

test("VS Code navigation has no rail gap and reveals from both DOM and native edges without moving the workspace", async () => {
  test.skip(
    !existsSync("/opt/homebrew/bin/code-server"),
    "Requires a local code-server installation",
  );
  test.setTimeout(90_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-vscode-rail-"));
  const paths = {
    cakeHome: join(temporary, "cake-home"),
    project: join(temporary, "project"),
    userData: join(temporary, "user-data"),
  };
  await Promise.all(
    [paths.project, paths.userData, join(paths.cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(paths.userData, "window-state.json"),
    windowState({ project: paths.project, theme: "dark" }),
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(paths.cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: paths.project, name: "Rail fixture", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      vscodeServerPath: "/opt/homebrew/bin/code-server",
    }),
  );
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
    await expect(
      page.getByRole("combobox", { name: "Message Cake Chat", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("button", { name: "Open Project Chat for Rail fixture", exact: true })
      .click();
    const open = page.getByRole("button", { name: "VS Code", exact: true });
    await expect(open).toBeVisible({ timeout: 20_000 });
    await open.click();
    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    const workspace = page.locator('[data-slot="workspace"]');
    const input = page.getByRole("combobox", { name: /^Message/ }).first();
    const edge = page.locator('[data-slot="project-rail-edge"]');
    const width = async () => (await rail.boundingBox())!.width;
    await input.focus();
    await page.mouse.move(600, 220);
    await expect(rail).toHaveAttribute("data-auto-hide", "true");
    await expect.poll(width).toBe(0);
    expect((await workspace.boundingBox())!.x).toBe(0);
    const before = await workspace.boundingBox();
    const nativeBounds = () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!
          .contentView.children.map((view) => view.getBounds())
          .find((bounds) => bounds.width > 0),
      );
    await expect.poll(async () => (await nativeBounds())?.x).toBe(0);

    // The DOM target works over host chrome/iframe surfaces.
    await edge.hover();
    await expect.poll(width).toBe(240);
    const settings = rail.getByRole("button", { name: "Settings", exact: true });
    await settings.hover();
    await expect(settings.locator('[data-slot="icon-button-label"]')).toBeVisible();
    expect(await workspace.boundingBox()).toEqual(before);
    await page.mouse.move(600, 220);
    await expect.poll(width).toBe(0);
    await expect.poll(async () => (await nativeBounds())?.x).toBe(0);

    // Real input into the native WebContentsView must reveal too: it covers the
    // DOM target when collapsed, with no reserved activation pixels.
    await application.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
        (candidate) => candidate.getBounds().width > 0,
      );
      if (!view || !("webContents" in view)) throw new Error("No native editor");
      (view as import("electron").WebContentsView).webContents.sendInputEvent({
        type: "mouseMove",
        x: 1,
        y: 150,
      });
    });
    await expect.poll(width).toBe(240);
    await expect.poll(async () => (await nativeBounds())?.x).toBe(240);
    await application.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children.find(
        (candidate) => candidate.getBounds().width > 0,
      ) as import("electron").WebContentsView;
      view.webContents.sendInputEvent({ type: "mouseMove", x: 30, y: 150 });
    });
    await expect.poll(width).toBe(0);

    // Tab into clipped navigation reveals it; leaving the pointer cannot hide
    // a focused control. No native window is shown or focused.
    const first = rail.getByRole("button", { name: "Open Cake Chat", exact: true });
    await first.focus();
    await expect(first).toBeFocused();
    await expect.poll(width).toBe(240);
    // Cake intentionally uses plain Tab to return to writing; Shift+Tab
    // retains sequential control navigation.
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await expect.poll(width).toBe(0);
    await rail.getByRole("button", { name: "Add project", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(first).toBeFocused();
    await settings.hover();
    await page.mouse.move(600, 220);
    await expect.poll(width).toBe(240);
    expect(await workspace.boundingBox()).toEqual(before);
    await input.focus();
    await expect.poll(width).toBe(0);

    await page.getByRole("button", { name: "Main", exact: true }).click();
    await page.mouse.move(600, 220);
    await input.focus();
    await expect(rail).toHaveAttribute("data-auto-hide", "false");
    await expect.poll(width).toBe(54);
    expect((await workspace.boundingBox())!.x).toBe(54);
    await expect(edge).toHaveCount(0);
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
