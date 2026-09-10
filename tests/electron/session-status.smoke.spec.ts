import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("customizes statuses and assigns one from the sidebar avatar", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-status-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "session-status";
  const timestamp = "2026-01-01T00:00:00.000Z";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(sessionDirectory, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Categorize this work" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Ready to categorize." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      theme: "dark",
      draftsBySession: {},
    }),
  );
  const applicationDocument = join(cakeHome, "state", "application.json");
  await writeFile(
    applicationDocument,
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Status project", addedAt: timestamp, lastOpenedAt: timestamp },
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
    await page.locator(`[data-session-id="${sessionId}"] .session-row`).click();
    await expect(
      page.locator('[data-slot="message-content"]', { hasText: "Categorize this work" }),
    ).toBeVisible({ timeout: 20_000 });
    const projectGroup = page.locator('[data-slot="project-group"]', {
      hasText: "Status project",
    });
    await projectGroup.hover();
    await projectGroup.getByRole("button", { name: "Open settings for project" }).click();

    await expect(page.getByRole("heading", { name: "Session statuses" })).toBeVisible();
    await expect(page.getByLabel("Feature status name")).toHaveValue("Feature");
    await page.getByLabel("New status name").fill("In review");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByLabel("In review status name")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    const sessionItem = page.locator(`[data-session-id="${sessionId}"]`);
    const picker = sessionItem.getByRole("button", {
      name: "Change session status. Current status: Unlabelled",
    });
    await expect(picker).toBeVisible();
    await picker.click();
    await page.getByRole("radio", { name: "In review" }).click();
    await expect(
      sessionItem.getByRole("button", {
        name: "Change session status. Current status: In review",
      }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const stored = JSON.parse(await readFile(applicationDocument, "utf8"));
        const state = stored.data ?? stored;
        const workflow = state.projects[0].workflow;
        const status = workflow.columns.find(
          (column: { name: string }) => column.name === "In review",
        );
        return workflow.assignments.some(
          (assignment: { sessionId: string; statusId: string }) =>
            assignment.sessionId === sessionId && assignment.statusId === status?.id,
        );
      })
      .toBe(true);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
