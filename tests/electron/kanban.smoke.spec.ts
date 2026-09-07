import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("creates a custom status and drags an active session into it", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-kanban-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionRoot = join(cakeHome, "pi", "sessions");
  const projectSessions = cakeWorkspaceSessionDirectory(project, sessionRoot);
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(projectSessions, { recursive: true }),
  ]);
  await writeFile(join(projectSessions, "2026-01-01T00-00-00-000Z_kanban-session.jsonl"), "");
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({ recentProjectPaths: [project], theme: "system" }),
  );
  const applicationDocument = join(cakeHome, "state", "application.json");
  await writeFile(
    applicationDocument,
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "Kanban project",
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
    },
  });
  try {
    const page = await application.firstWindow();
    const projectGroup = page.locator('[data-slot="project-group"]', { hasText: "Kanban project" });
    await expect(projectGroup.locator('[data-session-id="kanban-session"]')).toBeVisible({
      timeout: 20_000,
    });
    await projectGroup.hover();
    await projectGroup.getByRole("button", { name: "Open Kanban board for project" }).click();
    await expect(page.locator('[data-slot="kanban-board"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /^Terminal \(/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Add status" }).click();
    await page.getByLabel("Status name").fill("In review");
    await page.getByRole("button", { name: "Create status" }).click();
    const customColumn = page.locator('[data-column-id]:has-text("In review")');
    await expect(customColumn).toBeVisible();

    const card = page
      .locator('[data-slot="kanban-board"]')
      .locator('[data-session-id="kanban-session"]');
    await card.dragTo(customColumn);
    await expect(customColumn.locator('[data-session-id="kanban-session"]')).toBeVisible();
    await expect(
      projectGroup.locator('[data-session-id="kanban-session"] [aria-label="Status: In review"]'),
    ).toBeVisible();

    await expect(card).toBeEnabled();

    await page.getByRole("button", { name: "Add status" }).click();
    await page.getByLabel("Status name").fill("Blocked");
    await page.getByRole("button", { name: "Create status" }).click();
    const blockedColumn = page.locator('[data-column-id]:has-text("Blocked")');
    await expect(blockedColumn).toBeVisible();
    await page.getByRole("button", { name: "Drag to reorder Blocked" }).dragTo(customColumn);
    await expect
      .poll(() =>
        page.locator('[data-slot="kanban-board"] [data-column-id] strong').allTextContents(),
      )
      .toEqual(["Draft", "Active", "Blocked", "In review", "Resolved"]);

    const cardBounds = await card.boundingBox();
    if (!cardBounds) throw new Error("Kanban card bounds unavailable");
    await page.mouse.move(
      cardBounds.x + cardBounds.width / 2,
      cardBounds.y + cardBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(cardBounds.x + cardBounds.width / 2 + 12, cardBounds.y + 12, {
      steps: 4,
    });
    const resolveDropTarget = page.locator('[data-slot="kanban-resolve-drop-target"]');
    await expect(resolveDropTarget).toBeVisible();
    const targetBounds = await resolveDropTarget.boundingBox();
    if (!targetBounds) throw new Error("Resolve drop target bounds unavailable");
    await page.mouse.move(
      targetBounds.x + targetBounds.width / 2,
      targetBounds.y + targetBounds.height / 2,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect(
      page.locator('[data-column-id="resolved"] [data-session-id="kanban-session"]'),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const document = JSON.parse(await readFile(applicationDocument, "utf8"));
        return document.data.projects[0].workflow.assignments.length;
      })
      .toBe(1);

    await projectGroup.getByRole("button", { name: "Close Kanban board for project" }).click();
    await expect(page.locator('[data-slot="kanban-board"]')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
