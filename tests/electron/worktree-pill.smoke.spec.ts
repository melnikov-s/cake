import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

const sessionEntries = (sessionId: string, worktreePath: string) => {
  const timestamp = new Date(0).toISOString();
  return [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: worktreePath },
    {
      type: "message",
      id: `${sessionId}-user-1`,
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "Finished work" }], timestamp: 0 },
    },
  ];
};

test("chooses an isolated worktree without disturbing the new-chat composer", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-worktree-pill-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "cake@example.test"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "Cake Test"], { cwd: project });
  await writeFile(join(project, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "-A"], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: project });
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole("button", { name: "New chat in project", exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const newWorktree = page.getByRole("button", { name: "New worktree" });
    await expect(newWorktree).toBeVisible({ timeout: 5_000 });
    const currentCheckout = page.getByRole("button", { name: "Current checkout" });
    await expect(currentCheckout).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose existing worktree" })).toBeDisabled();

    await page.setViewportSize({ width: 520, height: 800 });
    const configurationPill = page.getByTestId("worktree-pill");
    await expect
      .poll(() =>
        configurationPill.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    await expect
      .poll(() => currentCheckout.evaluate((element) => element.clientWidth))
      .toBeLessThanOrEqual(32);
    await expect
      .poll(() =>
        currentCheckout.evaluate((element) => {
          const icon = element.querySelector(":scope > svg");
          if (!icon) return Number.POSITIVE_INFINITY;
          const buttonBounds = element.getBoundingClientRect();
          const iconBounds = icon.getBoundingClientRect();
          return Math.abs(
            buttonBounds.left + buttonBounds.width / 2 - (iconBounds.left + iconBounds.width / 2),
          );
        }),
      )
      .toBeLessThan(1);
    await expect(currentCheckout).toHaveAccessibleName("Current checkout");
    await currentCheckout.hover();
    await expect(page.getByRole("tooltip", { name: "Current checkout" })).toBeVisible();

    await newWorktree.click();
    await expect(newWorktree).toHaveAttribute("aria-pressed", "true");
    const initialChat = await page.locator('[data-slot="chat"]').elementHandle();
    expect(initialChat).not.toBeNull();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Build this in isolation");
    await expect(composer).toHaveValue("Build this in isolation");
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(composer).toHaveValue("", { timeout: 20_000 });
    await expect(page.getByText(/Session ID collision detected/)).toHaveCount(0);
    await expect(
      page.getByTestId("virtuoso-item-list").getByText("Build this in isolation", { exact: true }),
    ).toBeVisible();
    expect(await initialChat!.evaluate((element) => element.isConnected)).toBe(true);
    expect(
      await initialChat!.evaluate(
        (element) => document.querySelector('[data-slot="chat"]') === element,
      ),
    ).toBe(true);
    const pill = page.getByTestId("worktree-pill");
    await expect(pill).toBeVisible();
    const merge = page.getByRole("button", { name: "Merge", exact: true });
    await expect(merge).toBeVisible({ timeout: 5_000 });

    const resizePillTo = async (targetWidth: number) => {
      await pill.evaluate((element, width) => {
        element.style.width = `${width}px`;
        element.style.maxWidth = "none";
        element.style.flex = "none";
      }, targetWidth);
      await expect
        .poll(() => pill.evaluate((element) => element.getBoundingClientRect().width))
        .toBe(targetWidth);
    };

    // The branch uses the available toolbar space instead of disappearing at a fixed breakpoint.
    await resizePillTo(680);
    const branch = page.getByTestId("worktree-branch");
    const branchLabel = (await branch.textContent())?.trim();
    if (!branchLabel) throw new Error("Expected a worktree branch label");
    const visibleBranchLabel = branch.getByText(branchLabel, { exact: true });
    await expect
      .poll(() => visibleBranchLabel.evaluate((element) => getComputedStyle(element).position))
      .toBe("static");
    await expect
      .poll(() =>
        visibleBranchLabel.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    await branch.hover();
    await expect(page.getByRole("tooltip", { name: branchLabel })).toBeVisible();

    await resizePillTo(560);
    await expect.poll(() => merge.evaluate((element) => element.clientWidth)).toBeGreaterThan(32);
    await expect
      .poll(() =>
        page
          .getByTestId("worktree-pill-toolbar")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);

    // At the next breakpoint, actions retain their icons and accessible names only.
    await resizePillTo(450);
    await expect
      .poll(() => pill.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await expect
      .poll(() => merge.evaluate((element) => element.clientWidth))
      .toBeLessThanOrEqual(32);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("shows only the active branch or target-warning tooltip across hover and focus transitions", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-worktree-tooltip-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const worktreePath = join(temporaryRoot, "worktree");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "tooltip-session";
  const branchName = "verify-service-dependencies-4a5534";
  const warningText = "The merge target has uncommitted changes.";
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  const git = (args: string[], cwd = project) => execFileAsync("git", args, { cwd });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "cake@example.test"]);
  await git(["config", "user.name", "Cake Test"]);
  await writeFile(join(project, "README.md"), "fixture\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "fixture"]);
  await git(["worktree", "add", "-b", `agent/${branchName}`, worktreePath]);
  await writeFile(join(project, "target.ts"), "export const target = true;\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "advance target"]);
  // Both checkouts are dirty, just as in the report: warning and disabled Rebase are legitimate.
  await writeFile(join(project, "README.md"), "uncommitted target edits\n");
  await writeFile(join(worktreePath, "change.ts"), "export const change = true;\n");
  const initialTargetStatus = (await git(["status", "--porcelain"])).stdout;
  const sessionDirectory = cakeWorkspaceSessionDirectory(
    worktreePath,
    join(cakeHome, "pi", "sessions"),
  );
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${sessionEntries(sessionId, worktreePath)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "worktrees.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          projectPath: project,
          worktreePath,
          branch: `agent/${branchName}`,
          baseBranch: "main",
          state: "active",
          createdAt: new Date(0).toISOString(),
        },
      ],
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: worktreePath,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: worktreePath, sessionId },
      recentProjectPaths: [project],
      draftsBySession: {},
      draft: "",
      theme: "system",
    }),
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
    const branch = page.getByTestId("worktree-branch");
    const branchLabel = branch.getByText(branchName, { exact: true });
    const warning = page.getByTestId("worktree-target-warning");
    const tooltips = page.getByRole("tooltip");
    await expect(warning).toBeVisible({ timeout: 20_000 });
    await expect(warning).toHaveAccessibleName(warningText);
    await expect(page.getByRole("button", { name: "Rebase", exact: true })).toBeDisabled();

    // Enter the warning directly: entering a nested trigger must not also show the branch tooltip.
    await warning.hover();
    await expect(page.getByRole("tooltip", { name: warningText })).toBeVisible();
    await expect(tooltips).toHaveCount(1);

    await branchLabel.hover();
    await expect(tooltips).toHaveText(branchName);
    await warning.hover();
    await expect(tooltips).toHaveText(warningText);
    await branchLabel.hover();
    await expect(tooltips).toHaveText(branchName);
    await page.getByLabel("Message", { exact: true }).hover();
    await expect(tooltips).toHaveCount(0);

    // Keyboard focus must move between the two triggers without bubbling to the branch.
    await branch.focus();
    await expect(tooltips).toHaveText(branchName);
    await branch.press("Tab");
    await expect(warning).toBeFocused();
    await expect(tooltips).toHaveText(warningText);
    await warning.press("Shift+Tab");
    await expect(branch).toBeFocused();
    await expect(tooltips).toHaveText(branchName);

    // Mixed input and a quick transition before the hover delay must still yield one tooltip.
    await warning.hover();
    await expect(tooltips).toHaveText(warningText);
    await page.getByLabel("Message", { exact: true }).focus();
    await page.getByLabel("Message", { exact: true }).hover();
    await expect(tooltips).toHaveCount(0);
    await branchLabel.hover();
    await warning.hover();
    await expect(tooltips).toHaveText(warningText);
    await page.getByLabel("Message", { exact: true }).hover();
    await expect(tooltips).toHaveCount(0);

    // Tooltip changes do not alter the dirty-target safeguard or the target's files.
    await page.getByRole("button", { name: "Commit & merge", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("Merge with uncommitted target changes?");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await git(["status", "--porcelain"])).stdout).toBe(initialTargetStatus);
    expect(await readFile(join(project, "README.md"), "utf8")).toBe("uncommitted target edits\n");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("lands new commits from an already-landed worktree before resolving it", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-landed-worktree-pill-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const worktreePath = join(temporaryRoot, "project-worktree");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "landed-worktree-session";
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: project });
  await execFileAsync("git", ["config", "user.email", "cake@example.test"], { cwd: project });
  await execFileAsync("git", ["config", "user.name", "Cake Test"], { cwd: project });
  await writeFile(join(project, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "-A"], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: project });
  await execFileAsync("git", ["worktree", "add", "-b", "agent/finished", worktreePath], {
    cwd: project,
  });
  const baseCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: project })
  ).stdout.trim();
  await execFileAsync("git", ["branch", "upstream", baseCommit], { cwd: project });
  await writeFile(join(worktreePath, "README.md"), "old child patch\n");
  await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
  await execFileAsync("git", ["commit", "-m", "already landed patch"], { cwd: worktreePath });
  const landedSourceCommit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreePath })
  ).stdout.trim();
  await execFileAsync("git", ["merge", "--ff-only", "agent/finished"], { cwd: project });
  await execFileAsync("git", ["checkout", "upstream"], { cwd: project });
  await writeFile(join(project, "README.md"), "upstream change\n");
  await execFileAsync("git", ["add", "-A"], { cwd: project });
  await execFileAsync("git", ["commit", "-m", "upstream change"], { cwd: project });
  await execFileAsync("git", ["checkout", "main"], { cwd: project });
  await expect(execFileAsync("git", ["rebase", "upstream"], { cwd: project })).rejects.toThrow();
  await writeFile(join(project, "README.md"), "conflict-resolved old patch and upstream change\n");
  await execFileAsync("git", ["add", "-A"], { cwd: project });
  await execFileAsync("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: project });
  const sessionDirectory = cakeWorkspaceSessionDirectory(
    worktreePath,
    join(cakeHome, "pi", "sessions"),
  );
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${sessionEntries(sessionId, worktreePath)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "worktrees.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          projectPath: project,
          worktreePath,
          branch: "agent/finished",
          baseBranch: "main",
          baseCommit,
          landedSourceCommit,
          state: "landed",
          createdAt: new Date(0).toISOString(),
        },
      ],
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: worktreePath,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: worktreePath, sessionId },
      recentProjectPaths: [project],
      draftsBySession: {},
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /^Land new commit/ })).toHaveCount(0);
    await expect(page.getByText(/new commits? since landing/)).toHaveCount(0);

    await writeFile(join(worktreePath, "scratch.txt"), "uncommitted later work\n");
    await page.reload();
    await expect(page.getByRole("button", { name: "Commit & land", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/new commits? since landing/)).toHaveCount(0);
    await rm(join(worktreePath, "scratch.txt"));
    await writeFile(join(worktreePath, "follow-up.ts"), "export const followUp = true;\n");
    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    await execFileAsync("git", ["commit", "-m", "follow-up after landing"], { cwd: worktreePath });
    await page.reload();
    const landNewCommit = page.getByRole("button", { name: "Land new commit", exact: true });
    await expect(landNewCommit).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("1 new commit since landing", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
    await landNewCommit.click();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () =>
        (await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: project })).stdout.trim(),
      )
      .toBe("follow-up after landing");
    expect(await readFile(join(project, "README.md"), "utf8")).toBe(
      "conflict-resolved old patch and upstream change\n",
    );

    const composerWorktreeIcon = page.locator('.workbench-composer [data-worktree-state="landed"]');
    await expect(composerWorktreeIcon).toHaveAttribute("aria-label", "Merged worktree");
    await expect(composerWorktreeIcon).toHaveClass(/text-worktree-merged/);
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Discard & resolve", exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Commit & merge", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(page.getByRole("button", { name: "Current checkout", exact: true })).toBeVisible();
    await expect.poll(() => existsSync(worktreePath)).toBe(false);
    await page.getByRole("button", { name: "Expand Resolved" }).click();
    await page.getByRole("button", { name: "Expand project resolved" }).last().click();
    const resolvedSession = page.locator(
      `[data-slot="resolved-lane"] .session-item[data-session-id="${sessionId}"]`,
    );
    const restore = resolvedSession.getByRole("button", { name: /^Restore / });
    await expect(restore).toBeVisible();
    await resolvedSession.locator(".session-row").click();
    await expect(page.getByTestId("resolved-session-notice")).toBeVisible();
    await restore.click();
    await expect.poll(() => existsSync(worktreePath)).toBe(true);
    await expect(page.getByText(/Cake could not find session/)).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
