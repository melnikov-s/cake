import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("customizes labels and assigns multiple labels from the sidebar avatar", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-labels-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "session-labels";
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
        { path: project, name: "Label project", addedAt: timestamp, lastOpenedAt: timestamp },
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
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Session labels/ }).click();
    await expect(page.getByRole("heading", { name: "Global labels" })).toBeVisible();
    await expect(page.getByText("Feature", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add label" }).click();
    await page.getByLabel("New label name").fill("In review");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("In review", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Back to chat" }).click();
    const projectGroup = page.locator('[data-slot="project-group"]', {
      hasText: "Label project",
    });
    await projectGroup.hover();
    await projectGroup.getByRole("button", { name: "Open settings for project" }).click();
    await expect(page.getByRole("heading", { name: "Project-specific labels" })).toBeVisible();
    await page.getByRole("button", { name: "Add label" }).click();
    await page.getByLabel("New label name").fill("Project QA");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText("Project QA", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    const sessionItem = page.locator(`.session-item[data-session-id="${sessionId}"]`);
    const picker = sessionItem.getByRole("button", {
      name: "Change session labels. Current labels: Unlabelled",
    });
    await expect(picker).toBeVisible();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await picker.click();
    const popup = page
      .locator('[role="dialog"]')
      .filter({ has: page.getByRole("group", { name: "Session labels" }) });
    // Seek the real Electron animation to its overshoot rather than sleeping.
    const peakScale = await popup.evaluate((element) => {
      const animation = element.getAnimations()[0]!;
      animation.pause();
      animation.currentTime = 252;
      const scale = new DOMMatrix(getComputedStyle(element).transform).a;
      animation.finish();
      return scale;
    });
    expect(peakScale).toBeGreaterThan(1);
    await page.getByRole("checkbox", { name: "In review" }).click();
    await page.getByRole("checkbox", { name: "Project QA" }).click();
    const selectedPicker = sessionItem.getByRole("button", {
      name: "Change session labels. Current labels: In review, Project QA",
    });
    await expect(selectedPicker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(selectedPicker).toBeFocused();
    // Closing disables the content immediately, then removes the visual shell.
    await expect(page.getByRole("group", { name: "Session labels" })).toHaveCount(0);
    await expect(page.locator('[role="dialog"][data-state="closed"]')).toHaveCount(0);
    await selectedPicker.click();
    await page.keyboard.press("Escape");
    await selectedPicker.click();
    await expect(page.getByRole("checkbox", { name: "In review" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"][data-state="closed"]')).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await selectedPicker.click();
    expect(await popup.evaluate((element) => element.getAnimations().length)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"][data-state="closed"]')).toHaveCount(0);
    await expect(selectedPicker.locator('[data-slot="avatar"]')).toHaveAttribute(
      "data-session-label-color",
      /^oklch\(/,
    );

    await expect
      .poll(async () => {
        const stored = JSON.parse(await readFile(applicationDocument, "utf8"));
        const state = stored.data ?? stored;
        const workflow = state.projects[0].workflow;
        const status = state.globalSessionLabels.find(
          (candidate: { name: string }) => candidate.name === "In review",
        );
        const hasProjectStatus = workflow.labels.some(
          (candidate: { name: string }) => candidate.name === "Project QA",
        );
        return (
          hasProjectStatus &&
          workflow.assignments.some(
            (assignment: { sessionId: string; labelIds: string[] }) =>
              assignment.sessionId === sessionId &&
              assignment.labelIds[0] === status?.id &&
              assignment.labelIds.length === 2,
          )
        );
      })
      .toBe(true);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
