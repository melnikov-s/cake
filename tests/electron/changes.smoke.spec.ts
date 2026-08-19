import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

test("renders all changed files in one scrollable diff and synchronizes file navigation", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-changes-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "changes-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const originalSource = "export const value = 0;\n";
  const changedSource = [
    "export const values = [",
    ...Array.from({ length: 180 }, (_, index) => `  ${index},`),
    "];",
    "",
  ].join("\n");

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(join(project, "src", "app.ts"), originalSource);
  await git(project, "-c", "init.defaultBranch=main", "init");
  await git(project, "config", "user.name", "Cake Test");
  await git(project, "config", "user.email", "cake@example.test");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "Initial project");
  await writeFile(join(project, "src", "app.ts"), changedSource);
  await writeFile(join(project, "PLAN.md"), "# Plan\n");

  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      thinkingExpanded: false,
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      resolvedSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Review the project changes" }],
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
          content: [{ type: "text", text: "The workspace is ready for review." }],
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
    await expect(page.getByRole("combobox", { name: "Message" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Open workspace changes" }).click();

    const diff = page.locator(".change-explorer-all-diff");
    await expect(diff).toBeVisible({ timeout: 20_000 });
    await expect(diff.locator(".change-explorer-file-section")).toHaveCount(2);
    await expect(diff).toContainText("export const values");
    await expect(diff).toContainText("# Plan");

    const firstButton = page
      .locator('nav[aria-label="Changed files"] button')
      .filter({ hasText: "app.ts" });
    const planButton = page
      .locator('nav[aria-label="Changed files"] button')
      .filter({ hasText: "PLAN.md" });
    await firstButton.click();
    await expect(firstButton).toHaveClass(/active/);
    await diff.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(planButton).toHaveClass(/active/);

    await planButton.click();
    await expect(planButton).toHaveClass(/active/);
    await expect.poll(() => diff.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
