import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

test("chooses an isolated worktree without disturbing the new-chat composer", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-worktree-pill-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
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
    await expect(page.getByRole("button", { name: "Current checkout" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose existing worktree" })).toBeDisabled();
    await newWorktree.click();
    await expect(newWorktree).toHaveAttribute("aria-pressed", "true");
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Build this in isolation");
    await expect(composer).toHaveValue("Build this in isolation");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
