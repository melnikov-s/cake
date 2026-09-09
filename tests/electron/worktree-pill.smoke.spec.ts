import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await expect(currentCheckout).toHaveAttribute("title", "Current checkout");
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
    await expect(page.locator('[data-slot="worktree-pill"]')).toBeVisible();
    const merge = page.getByRole("button", { name: "Merge", exact: true });
    await expect(merge).toBeVisible({ timeout: 5_000 });

    await page.setViewportSize({ width: 420, height: 800 });
    const pill = page.getByTestId("worktree-pill");
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

test("shows only resolve after a worktree is merged and removes the checkout", async () => {
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
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible({
      timeout: 20_000,
    });
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
    await expect(page.locator('[data-slot="worktree-pill"]')).toHaveCount(0);
    await restore.click();
    await expect.poll(() => existsSync(worktreePath)).toBe(true);
    await expect(page.getByText(/Cake could not find session/)).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
