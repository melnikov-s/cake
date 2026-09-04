import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, _electron as electron } from "@playwright/test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("edits and persists project-specific worktree settings", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-project-settings-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const project = join(temporaryRoot, "project");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  const applicationPath = join(cakeHome, "state", "application.json");
  await writeFile(
    applicationPath,
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "Smoke project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
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
    await page.getByRole("button", { name: "Open settings for project" }).click();
    const createCommand = page.getByLabel("Worktree creation command");
    const setupCommands = page.getByLabel("Setup commands");
    await expect(createCommand).toHaveValue(
      "git worktree add -b {branchName} {worktreePath} {baseCommit}",
    );
    await createCommand.fill("my-worktree {worktreeName} {worktreePath}");
    await setupCommands.fill("pnpm install");
    await expect(createCommand).toHaveValue("my-worktree {worktreeName} {worktreePath}");
    await expect(setupCommands).toHaveValue("pnpm install");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect
      .poll(async () => {
        const document = JSON.parse(await readFile(applicationPath, "utf8"));
        return document.data?.projects?.[0]?.settings;
      })
      .toEqual({
        worktreeCreateCommand: "my-worktree {worktreeName} {worktreePath}",
        worktreeSetupCommands: "pnpm install",
      });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
