import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Effect } from "effect";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import {
  makeActivityHistoryLive,
  recordActivity,
} from "../../src/services/storage/ActivityHistory";
import { seedAutomationVisualFixture } from "../fixtures/automations";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Activity reopens durable records and filters, with links into the project and automation rule", async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "cake-activity-ui-"));
  const paths = {
    cakeHome: join(directory, "home"),
    project: join(directory, "project"),
    userData: join(directory, "user-data"),
  };
  let cleanup: (() => Promise<void>) | undefined;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const launch = async () => {
    application = await electron.launch({
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
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900),
    );
    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    const activity = rail.getByRole("button", { name: "Activity history", exact: true });
    await expect(activity).toBeVisible({ timeout: 20_000 });
    await activity.click();
    return {
      page,
      activity,
      dialog: page.getByRole("dialog", { name: "Activity history", exact: true }),
    };
  };
  try {
    cleanup = await seedAutomationVisualFixture(paths, "light");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordActivity({
          id: "fixture-notice",
          kind: "notification",
          title: "Review is ready",
          detail: "The focused checks passed. Review the work before the release.",
          at: "2030-01-01T09:00:00.000Z",
          tone: "info",
          projectPath: paths.project,
        });
        yield* recordActivity({
          id: "fixture-merge",
          kind: "merge",
          title: "Worktree merged",
          detail: "Landed on main · 38c7164",
          at: "2030-01-01T09:02:00.000Z",
          projectPath: paths.project,
        });
        yield* recordActivity({
          id: "fixture-resolution",
          kind: "resolution",
          title: "Project Session resolved",
          at: "2030-01-01T09:03:00.000Z",
          projectPath: paths.project,
        });
      }).pipe(Effect.provide(makeActivityHistoryLive(join(paths.cakeHome, "state")))),
    );

    const first = await launch();
    await expect(first.dialog.getByText("Review is ready")).toBeVisible();
    await application?.close();
    application = undefined;
    const { page, activity, dialog } = await launch();
    const rows = dialog.getByRole("list", { name: "Activity events" }).getByRole("listitem");
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText("Project Session resolved");
    await expect(rows.nth(1)).toContainText("Worktree merged");
    const screenshot = testInfo.outputPath("activity-history.png");
    await page.screenshot({ path: screenshot, animations: "disabled", scale: "css" });
    await testInfo.attach("Activity history", { path: screenshot, contentType: "image/png" });

    await dialog.getByLabel("Project", { exact: true }).selectOption(paths.project);
    await dialog.getByLabel("Event type").selectOption("merge");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Worktree merged");
    await rows.first().getByRole("button", { name: "Cake", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Open Project Chat for Cake" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await activity.click();
    await dialog.getByLabel("Project", { exact: true }).selectOption(paths.project);
    await dialog.getByLabel("Event type").selectOption("automation");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Review child replies");
    await expect(rows.first()).toContainText("Completed");
    await rows.first().getByRole("button", { name: "Open run", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Review child replies", { exact: true }).first()).toBeVisible();
    await activity.click();
    await dialog.getByLabel("Project", { exact: true }).selectOption(paths.project);
    await dialog.getByLabel("Event type").selectOption("automation");
    await rows.first().getByRole("button", { name: "Open rule", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Review child replies", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Automation name" })).toHaveValue(
      "Review child replies",
    );
  } finally {
    await application?.close();
    await cleanup?.();
    await rm(directory, { recursive: true, force: true });
  }
});
