// Temporary probe: the workspace-header sidebar toggle must stay hidden while
// the project sidebar is expanded, and sit on the same horizontal line as the
// sidebar's window-tools row once the sidebar collapses.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("header sidebar toggle only appears when the sidebar is collapsed", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-toggle-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [],
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
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });

    // Expanded: the duplicate header toggle must be hidden.
    await expect(page.locator('[data-slot="header-sidebar-toggle"]')).toBeHidden();
    // The sidebar's own toggle remains visible.
    await expect(
      page.getByRole("complementary").getByRole("button", { name: "Toggle sidebar" }),
    ).toBeVisible();

    // Collapse the sidebar.
    await page.getByRole("complementary").getByRole("button", { name: "Toggle sidebar" }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const workspace = document
            .querySelector('[data-slot="workspace"]')
            ?.getBoundingClientRect();
          return Boolean(workspace && workspace.left === 0 && workspace.right === innerWidth);
        }),
      )
      .toBe(true);

    const state = await page.evaluate(() => {
      const toggle = document.querySelector('[data-slot="header-sidebar-toggle"]');
      const rect = toggle?.getBoundingClientRect();
      const workspace = document.querySelector('[data-slot="workspace"]')?.getBoundingClientRect();
      const display = toggle ? getComputedStyle(toggle).display : "";
      return {
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
        workspaceFillsWindow: Boolean(
          workspace && workspace.left === 0 && workspace.right === innerWidth,
        ),
        clearsWindowControls: Boolean(rect && rect.left >= 84),
        // Same horizontal line as the 46px .sidebar-window-tools row (28px
        // buttons centered in it → 23px from the window's top edge) despite
        // this header being 52px tall.
        alignedWithWindowToolsRow: Boolean(rect) && Math.abs(rect!.top + rect!.height / 2 - 23) < 2,
        display,
      };
    });
    expect(state).toEqual({
      visible: true,
      workspaceFillsWindow: true,
      clearsWindowControls: true,
      alignedWithWindowToolsRow: true,
      display: "grid",
    });

    // Expand again: the toggle hides once more.
    await page.locator('[data-slot="header-sidebar-toggle"]').click();
    await expect(page.locator('[data-slot="header-sidebar-toggle"]')).toBeHidden();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
