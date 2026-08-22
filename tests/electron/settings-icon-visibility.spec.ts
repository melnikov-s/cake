import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const headerSidebarToggle = (page: Page) =>
  page.locator("header").getByRole("button", { name: "Toggle sidebar" });

test("workspace settings icon visibility follows sidebar state", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-settings-icon-check-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
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
      thinkingExpanded: false,
    }),
  );
  await writeFile(
    join(userData, "application.json"),
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
      resolvedSessionIds: [],
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
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });

    // Sidebar shown: workspace gear hidden, sidebar gear visible.
    await expect(page.locator(".sidebar-settings-icon")).toBeVisible();
    await expect(page.locator(".workspace-settings-icon")).toBeHidden();

    // Collapse the sidebar: sidebar gear is clipped out of the 0-width sidebar,
    // and the workspace gear appears at the exact spot that keeps both gears'
    // centers on the same horizontal line.
    await headerSidebarToggle(page).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const read = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              bottomGap: innerHeight - rect.bottom,
              centerFromBottom: innerHeight - (rect.top + rect.height / 2),
            };
          };
          const sidebarGear = read(".sidebar-settings-icon");
          const workspaceGear = read(".workspace-settings-icon");
          if (!sidebarGear || !workspaceGear) return null;
          return { sidebarGear, workspaceGear };
        }),
      )
      .toEqual({
        sidebarGear: {
          left: -6,
          right: 26,
          bottomGap: 9.5,
          centerFromBottom: 25.5,
        },
        workspaceGear: {
          left: 16,
          right: 48,
          bottomGap: 9.5,
          centerFromBottom: 25.5,
        },
      });

    // Reopen the sidebar: workspace gear hides again.
    await headerSidebarToggle(page).click();
    await expect(page.locator(".workspace-settings-icon")).toBeHidden();
    await expect(page.locator(".sidebar-settings-icon")).toBeVisible();

    // The sidebar gear rests with its center 25.5px from the bottom of the
    // window, exactly where the workspace gear appears when the sidebar hides.
    const sidebarCenter = await page.evaluate(() => {
      const element = document.querySelector(".sidebar-settings-icon");
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return innerHeight - (rect.top + rect.height / 2);
    });
    expect(sidebarCenter).not.toBeNull();
    expect(Math.abs((sidebarCenter ?? 0) - 25.5)).toBeLessThan(0.5);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
