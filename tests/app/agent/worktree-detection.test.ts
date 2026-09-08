import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { detectGitWorktree } from "../../../src/services/pi/runtime/worktree-system-prompt";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function createRepository() {
  const repository = await mkdtemp(join(tmpdir(), "cake-worktree-prompt-"));
  temporaryDirectories.push(repository);
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.email", "cake@example.test");
  await git(repository, "config", "user.name", "Cake Test");
  await writeFile(join(repository, "README.md"), "test\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "initial");
  return repository;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("worktree detection", () => {
  it("detects a linked worktree but not the main checkout", async () => {
    const repository = await createRepository();
    const worktree = `${repository}-linked`;
    temporaryDirectories.push(worktree);
    await git(repository, "worktree", "add", "-b", "agent/fix", worktree);

    await expect(detectGitWorktree(repository)).resolves.toBeUndefined();
    await expect(detectGitWorktree(worktree)).resolves.toEqual({
      worktreePath: await realpath(worktree),
      mainCheckoutPath: await realpath(repository),
      branch: "agent/fix",
    });
  });

  it("returns no context outside a Git repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-no-repository-"));
    temporaryDirectories.push(directory);

    await expect(detectGitWorktree(directory)).resolves.toBeUndefined();
  });
});
