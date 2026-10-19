import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`hover replaces the unread dot with Resolve without opening the session (${theme})`, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-hover-resolve-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    const timestamp = new Date(0).toISOString();
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId: "selected", theme }),
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
          trustedProjectPaths: [project],
          unreadSessionIds: ["completed-projects", "completed-activity"],
        },
      }),
    );
    for (const sessionId of ["selected", "completed-projects", "completed-activity"]) {
      await writeFile(
        join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
        [
          { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
          {
            type: "message",
            id: `${sessionId}-user`,
            parentId: null,
            timestamp,
            message: {
              role: "user",
              content: [{ type: "text", text: sessionId }],
              timestamp: 0,
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
    }
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
      const sidebar = page.locator('[data-slot="sidebar"]');
      const selected = sidebar.locator('[data-session-id="selected"]');
      await expect(selected).toHaveAttribute("data-navigation-active", "true", { timeout: 20_000 });
      for (const mode of ["projects", "activity"]) {
        if (mode === "activity") {
          await sidebar.getByRole("button", { name: "Show activity", exact: true }).click();
        }
        const scope = sidebar.locator(
          mode === "projects" ? '[data-slot="project-group"]' : '[data-slot="activity-feed"]',
        );
        const row = scope.locator(`[data-session-id="completed-${mode}"]`);
        const dot = row.getByRole("img", { name: "Ready, unread" });
        const action = row.getByRole("button", { name: /^Resolve / });
        await page.mouse.move(0, 0);
        await expect(dot).toBeVisible();
        await expect(action).toHaveCount(1);
        await expect(action).toHaveCSS("opacity", "0");
        await row.locator(".session-title").hover();
        await expect(action).toHaveCSS("opacity", "1");
        await expect(dot.locator("..")).toHaveCSS("opacity", "0");
        await expect(row).toHaveAttribute("data-navigation-active", "false");
        await page.mouse.move(0, 0);
        await expect(action).toHaveCSS("opacity", "0");
        await expect(dot.locator("..")).toHaveCSS("opacity", "1");
        // The same replacement is available to keyboard users without navigation.
        await action.focus();
        await expect(action).toHaveCSS("opacity", "1");
        await expect(dot.locator("..")).toHaveCSS("opacity", "0");
        await row.hover();
        await action.click();
        await expect(row).toHaveCount(0);
        await expect(selected).toHaveAttribute("data-navigation-active", "true");
      }
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
