import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { windowState } from "../fixtures/window-state";

for (const theme of ["dark", "light"] as const) {
  test(`project labels and fixed Workspace toggle (${theme})`, async () => {
    test.setTimeout(90_000);
    const temporary = await mkdtemp(join(tmpdir(), "cake-shell-labels-"));
    const paths = {
      cakeHome: join(temporary, "cake-home"),
      project: join(temporary, "project"),
      userData: join(temporary, "user-data"),
    };
    await Promise.all([
      mkdir(paths.project, { recursive: true }),
      mkdir(paths.userData, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
    ]);
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowState({ project: paths.project, theme }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: paths.project,
            name: "cake",
            addedAt: new Date(0).toISOString(),
            lastOpenedAt: new Date(0).toISOString(),
          },
        ],
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
      const window = await application.browserWindow(page);
      await window.evaluate((native) => {
        native.setMinimumSize(320, 320);
        native.setContentSize(960, 784);
      });
      await page.getByRole("button", { name: "Open Project Chat for cake", exact: true }).click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      const breadcrumb = page.getByRole("navigation", { name: "Conversation breadcrumb" });
      await expect(breadcrumb.getByRole("button")).toHaveText(["Cake Chat", "cake"]);
      await expect(breadcrumb.getByRole("button", { name: "cake", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.locator('[data-slot="workspace-actions"] strong')).toHaveText("cake");
      const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
      await expect(rail.getByRole("button", { name: /^(Open|Close) Workspace$/ })).toHaveCount(0);
      const toggle = page.locator('[data-slot="shell-workspace-toggle"]');
      await expect(toggle).toHaveCount(1);
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      const output = resolve(repositoryRoot, ".visual-captures");
      await mkdir(output, { recursive: true });
      for (const width of [960, 680]) {
        await window.evaluate((native, width) => native.setContentSize(width, 784), width);
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
        await expect(workspace).toBeVisible();
        const initial = (await toggle.boundingBox())!;
        expect(initial.x + initial.width).toBe(width - 8);
        expect(initial.y).toBeLessThan(40);
        const assertPosition = async () => {
          const current = (await toggle.boundingBox())!;
          expect(current).toEqual(initial);
        };
        await page.screenshot({ path: join(output, `shell-labels-${theme}-${width}-open.png`) });
        await toggle.click();
        await expect(workspace).toHaveCount(0);
        await expect(toggle).toHaveAccessibleName("Open Workspace");
        await assertPosition();
        await page.screenshot({ path: join(output, `shell-labels-${theme}-${width}-closed.png`) });
        await toggle.focus();
        await page.keyboard.press("Enter");
        await expect(workspace).toBeVisible();
        await expect(toggle).toHaveAccessibleName("Close Workspace");
        await assertPosition();
        await expect(toggle).toHaveCSS("-webkit-app-region", "no-drag");
        console.log(`${theme} ${width}: open/closed/reopened toggle ${JSON.stringify(initial)}`);
      }
      await workspace.getByRole("button", { name: /^Sessions / }).click();
      await expect(workspace.getByRole("button", { name: "cake", exact: true })).toBeVisible();
      await expect(
        workspace.getByRole("button", { name: "Project Chat", exact: true }),
      ).toHaveCount(0);
      const windows = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((native) => ({
          visible: native.isVisible(),
          focused: native.isFocused(),
        })),
      );
      expect(windows.every((native) => !native.visible && !native.focused)).toBe(true);
    } finally {
      await application.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
