import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

const sessionEntries = (sessionId: string, cwd: string, text: string) => {
  const timestamp = new Date(0).toISOString();
  return [
    { type: "session", version: 3, id: sessionId, timestamp, cwd },
    {
      type: "message",
      id: `${sessionId}-user-1`,
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
    },
  ];
};

// Every visible family pane observes the shared worktree's landing. One Merge & resolve on the
// root must still produce exactly one completion toast for the whole resolved family.
test("merging and resolving a family root shows one consolidated toast", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-family-merge-resolve-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const worktreePath = join(temporaryRoot, "project-worktree");
  const cakeHome = join(temporaryRoot, "cake-home");
  const parent = "family-parent";
  const children = [
    { sessionId: "family-child-1", parentSessionId: parent },
    { sessionId: "family-child-2", parentSessionId: parent },
    { sessionId: "family-grandchild", parentSessionId: "family-child-1" },
  ];
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  const git = (args: string[], cwd = project) => execFileAsync("git", args, { cwd });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "cake@example.test"]);
  await git(["config", "user.name", "Cake Test"]);
  await writeFile(join(project, "README.md"), "fixture\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "fixture"]);
  const baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["worktree", "add", "-b", "agent/family", worktreePath]);
  await writeFile(join(worktreePath, "family.ts"), "export const family = true;\n");
  await git(["add", "-A"], worktreePath);
  await git(["commit", "-m", "family work"], worktreePath);

  const sessionDirectory = cakeWorkspaceSessionDirectory(
    worktreePath,
    join(cakeHome, "pi", "sessions"),
  );
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await Promise.all(
    [parent, ...children.map((child) => child.sessionId)].map((sessionId) =>
      writeFile(
        join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
        `${sessionEntries(sessionId, worktreePath, sessionId)
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
      ),
    ),
  );
  await writeFile(
    join(cakeHome, "state", "worktrees.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          projectPath: project,
          worktreePath,
          branch: "agent/family",
          baseBranch: "main",
          baseCommit,
          state: "active",
          createdAt: new Date(0).toISOString(),
        },
      ],
    }),
  );
  await writeFile(
    join(cakeHome, "state", "session-families.json"),
    JSON.stringify({
      version: 7,
      data: {
        families: [
          {
            familyId: "family-1",
            parentSessionId: parent,
            projectPath: project,
            workingDirectory: worktreePath,
            managedWorktreePath: worktreePath,
            createdAt: new Date(0).toISOString(),
            children: children.map((child, index) => ({
              ...child,
              requestId: `request-${index}`,
              workingDirectory: worktreePath,
              createdAt: new Date(0).toISOString(),
            })),
          },
        ],
        turns: [],
        spawnedSessions: [],
      },
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project: worktreePath, sessionId: parent, theme: "system" }),
  );
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    const panes = page.locator('[data-slot="session-pane"]');
    await expect(panes).toHaveCount(1, { timeout: 20_000 });
    // Open two descendants beside the root (the child pane is reused), so the root and both
    // descendants have rendered Worktree pills observing the same landing.
    for (const [index, child] of children.slice(0, 2).entries())
      await emitRendererEvent(application, {
        type: "project-session-control-requested",
        sessionId: parent,
        controlRequestId: `00000000-0000-4000-8000-00000000000${index}`,
        invocation: {
          _tag: "ProjectChildSession",
          childSessionId: child.sessionId,
          title: child.sessionId,
          familyId: "family-1",
          familyChildOrder: index,
          familyDepth: 1,
          workingDirectory: worktreePath,
          placement: "right",
        },
      });
    await expect(panes).toHaveCount(2);
    await expect(panes.nth(1)).toHaveAttribute("data-session-id", children[1]!.sessionId);
    const parentPane = page.locator(`[data-slot="session-pane"][data-session-id="${parent}"]`);
    await parentPane.getByRole("combobox", { name: "Message", exact: true }).click();
    const mergeAndResolve = parentPane.getByRole("button", { name: "Merge & resolve" });
    await expect(mergeAndResolve).toBeVisible({ timeout: 20_000 });
    await mergeAndResolve.click();

    const toasts = page.locator('[aria-live="polite"] > [role="status"]');
    await expect(toasts.filter({ hasText: "merged and resolved" })).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toContainText("Sessions merged and resolved");
    await expect(toasts).toContainText("4 sessions were resolved");
    await page.screenshot({
      path: join(repositoryRoot, ".visual-captures", "family-merge-resolve-toast.png"),
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect((await git(["log", "-1", "--format=%s"])).stdout.trim()).toBe("family work");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
