import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { seedSessionChanges } from "../fixtures/session-changes";

const repository = resolve(import.meta.dirname, "../..");

test("VS Code Changes replaces shown and hidden companions outside the native editor bounds", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-vscode-changes-"));
  const paths = {
    project: join(directory, "project"),
    cakeHome: join(directory, "cake"),
    userData: join(directory, "user-data"),
  };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedSessionChanges(paths);
    app = await electron.launch({
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
    const application = app;
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Open VS Code", exact: true }).click();
    const nativeEditor = () =>
      application.evaluate(({ BrowserWindow }) => {
        const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find((child) =>
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
        );
        return view
          ? { id: view.webContents.id, visible: view.getVisible(), ...view.getBounds() }
          : undefined;
      });
    await expect.poll(async () => (await nativeEditor())?.visible, { timeout: 20_000 }).toBe(true);
    const original = await nativeEditor();
    const companion = page.getByRole("complementary", { name: "Current conversation companion" });
    const panel = page.getByRole("complementary", { name: "Changes", exact: true });
    const toggle = page.getByRole("button", { name: "Review changes · 3 commits", exact: true });
    for (const shown of [true, false]) {
      if (!shown) {
        await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
        await expect
          .poll(async () => (await nativeEditor())!.width)
          .toBeGreaterThan(original!.width);
      } else await companion.getByRole("button", { name: "Sessions", exact: true }).click();
      const before = await nativeEditor();
      await toggle.click();
      await expect(panel).toBeVisible();
      await expect(companion.getByRole("group", { name: "Companion content" })).toHaveCount(0);
      await expect
        .poll(async () => {
          const native = await nativeEditor();
          const bounds = await panel.boundingBox();
          return Boolean(
            native?.visible &&
            bounds &&
            native.id === original?.id &&
            native.width > 300 &&
            native.x + native.width <= bounds.x + 1,
          );
        })
        .toBe(true);
      const commit = panel.getByRole("button", { name: /Show commit history in the changes pane/ });
      if ((await commit.getAttribute("aria-expanded")) !== "true") await commit.click();
      await panel
        .getByRole("button", { name: /src\/review-pane.ts/ })
        .first()
        .click();
      await expect
        .poll(() =>
          application.evaluate(async ({ webContents }) => {
            for (const contents of webContents.getAllWebContents()) {
              if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
              const tab = await contents.executeJavaScript(
                'document.querySelector(".tab.active")?.textContent',
              );
              if (tab?.includes("review-pane.ts")) return true;
            }
            return false;
          }),
        )
        .toBe(true);
      await panel.getByRole("button", { name: "Refresh changes", exact: true }).click();
      await expect(
        panel.getByRole("button", { name: "Refresh changes", exact: true }),
      ).toBeEnabled();
      await panel.getByRole("button", { name: "Close Changes", exact: true }).click();
      await expect(panel).toHaveCount(0);
      if (shown) {
        await expect(companion).toBeVisible();
        await expect(
          companion.getByRole("button", { name: "Sessions", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
      } else await expect(companion).toHaveCount(0);
      await expect
        .poll(async () => {
          const native = await nativeEditor();
          return native?.visible && native.id === original?.id && native.width === before?.width;
        })
        .toBe(true);
    }
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Changes shares responsive panels: wide split, narrow and Browser Mode replacement, X restores chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-session-changes-"));
  const paths = {
    project: join(directory, "project"),
    cakeHome: join(directory, "cake"),
    userData: join(directory, "user-data"),
  };
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedSessionChanges(paths);
    app = await electron.launch({
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
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    const toggle = page.getByRole("button", { name: "Review changes · 3 commits", exact: true });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("3");
    await toggle.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("complementary", { name: "Changes", exact: true });
    await expect(panel).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const layout = page.locator('[data-slot="side-chat-layout"]');
    await expect(layout).toHaveAttribute("data-presentation", "side-by-side");
    const input = page.getByRole("combobox", { name: "Message", exact: true });
    await input.click();
    await input.pressSequentially("Keep reviewing after closing Changes");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keep reviewing after closing Changes");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    const commit = panel.getByRole("button", { name: /Show commit history in the changes pane/ });
    await commit.focus();
    await page.keyboard.press("Space");
    await expect(commit).toHaveAttribute("aria-expanded", "true");
    const file = panel.getByRole("button", { name: /src\/review-pane.ts/ }).first();
    await expect(file).toContainText("+1");
    await expect(file).toContainText("−0");
    await expect(panel.getByRole("region", { name: "Staged", exact: true })).toContainText(
      "README.md",
    );
    await expect(panel.getByRole("region", { name: "Unstaged", exact: true })).toContainText(
      "src/session-changes.ts",
    );
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(layout).toHaveAttribute("data-presentation", "replacement");
    await expect(input).toBeHidden();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close Changes", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keep reviewing after closing Changes");
    await toggle.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(input).toBeFocused();

    // The same breakpoint applies to Browser Mode's narrower chat drawer,
    // even when the overall window is wide.
    await page.setViewportSize({ width: 1440, height: 900 });
    await toggle.click();
    await page.getByRole("button", { name: "Open Browser Mode", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Browser workspace", exact: true }),
    ).toBeVisible();
    await expect(layout).toHaveAttribute("data-presentation", "replacement");
    await expect(panel).toBeVisible();
    await expect(input).toBeHidden();
    await panel.getByRole("button", { name: "Close Changes", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Keep reviewing after closing Changes");
    await input.press("ControlOrMeta+A");
    await input.pressSequentially("Continue reviewing in Browser Mode");
    await expect(input).toHaveValue("Continue reviewing in Browser Mode");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
