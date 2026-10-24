// Temporary probe: the workspace-header sidebar toggle must stay hidden while
// the project sidebar is expanded, and sit on the same horizontal line as the
// sidebar's window-tools row once the sidebar collapses.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("header sidebar toggle only appears when the sidebar is collapsed", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-toggle-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, theme: "system" }));
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
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
      const header = document.querySelector('[data-slot="workspace-header"]');
      const toggle = document.querySelector('[data-slot="header-sidebar-toggle"]');
      const avatar = header?.querySelector('[data-slot="avatar"]');
      const title = header?.querySelector("strong");
      const rightButtons = Array.from(
        header?.querySelectorAll(":scope > div:last-child button") ?? [],
      ).filter((button) => {
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      const centerY = (element: Element | null | undefined) => {
        const box = element?.getBoundingClientRect();
        return box ? box.top + box.height / 2 : null;
      };
      const rect = toggle?.getBoundingClientRect();
      const toggleCenter = centerY(toggle);
      const avatarCenter = centerY(avatar);
      const titleCenter = centerY(title);
      const workspace = document.querySelector('[data-slot="workspace"]')?.getBoundingClientRect();
      const display = toggle ? getComputedStyle(toggle).display : "";
      return {
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
        workspaceFillsWindow: Boolean(
          workspace && workspace.left === 0 && workspace.right === innerWidth,
        ),
        clearsWindowControls: Boolean(rect && rect.left >= 84),
        // Same horizontal centerline across toggle, project icon, title, and right-side icons.
        alignedWithWindowToolsRow:
          toggleCenter !== null &&
          titleCenter !== null &&
          rightButtons.length > 0 &&
          Math.abs(toggleCenter - 26.5) < 1 &&
          (avatarCenter === null || Math.abs(avatarCenter - toggleCenter) < 0.5) &&
          Math.abs(titleCenter - toggleCenter) < 0.5 &&
          rightButtons.every((button) => Math.abs((centerY(button) ?? 0) - toggleCenter) < 0.5),
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
