import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedWorktreeEngine } from "../../src/services/worktrees/ManagedWorktreeEngine";
import { makeTestWorktreeStorageRepository } from "../helpers/worktree-storage-repository";

const execFileAsync = promisify(execFile);
const cleanupPaths = new Set<string>();

afterEach(async () => {
  for (const path of cleanupPaths) await rm(path, { recursive: true, force: true });
  cleanupPaths.clear();
});

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function repository() {
  const path = await mkdtemp(join(tmpdir(), "cake-dirty-worktree-base-"));
  cleanupPaths.add(path);
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.email", "cake@example.test");
  await git(path, "config", "user.name", "Cake Test");
  await writeFile(join(path, "tracked.txt"), "committed tracked\n");
  await writeFile(join(path, "staged.txt"), "committed staged\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "base");
  return path;
}

function service() {
  const storage = join(
    tmpdir(),
    `cake-dirty-worktree-store-${Math.random().toString(16).slice(2)}.json`,
  );
  cleanupPaths.add(storage);
  return new ManagedWorktreeEngine(
    makeTestWorktreeStorageRepository(storage),
    async (cwd, args) =>
      (await execFileAsync("git", [...args], { cwd, maxBuffer: 4_000_000 })).stdout,
  );
}

async function makeDirty(cwd: string) {
  await writeFile(join(cwd, "tracked.txt"), "uncommitted tracked\n");
  await writeFile(join(cwd, "staged.txt"), "uncommitted staged\n");
  await git(cwd, "add", "staged.txt");
  await writeFile(join(cwd, "untracked.txt"), "uncommitted untracked\n");
}

async function status(cwd: string) {
  return (await git(cwd, "status", "--short")).stdout;
}

async function expectCommittedCheckout(cwd: string, expectedHead: string) {
  expect((await git(cwd, "rev-parse", "HEAD")).stdout.trim()).toBe(expectedHead);
  await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("committed tracked\n");
  await expect(readFile(join(cwd, "staged.txt"), "utf8")).resolves.toBe("committed staged\n");
  await expect(readFile(join(cwd, "untracked.txt"), "utf8")).rejects.toThrow();
  await expect(status(cwd)).resolves.toBe("");
}

describe("managed worktree creation from a dirty base", { timeout: 20_000 }, () => {
  it("branches from the project checkout's committed HEAD without carrying its changes", async () => {
    const repo = await repository();
    const worktrees = service();
    const expectedHead = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    await makeDirty(repo);
    const originalStatus = await status(repo);

    const child = await worktrees.create(repo, repo, "dirty-root-child");
    cleanupPaths.add(dirname(child.worktreePath));

    expect(child.baseCommit).toBe(expectedHead);
    expect(child.parentWorktreePath).toBeUndefined();
    await expectCommittedCheckout(child.worktreePath, expectedHead);
    await expect(status(repo)).resolves.toBe(originalStatus);
    await expect(readFile(join(repo, "tracked.txt"), "utf8")).resolves.toBe(
      "uncommitted tracked\n",
    );
    await expect(readFile(join(repo, "staged.txt"), "utf8")).resolves.toBe("uncommitted staged\n");
    await expect(readFile(join(repo, "untracked.txt"), "utf8")).resolves.toBe(
      "uncommitted untracked\n",
    );
  });

  it("recursively branches from a dirty managed parent's committed HEAD", async () => {
    const repo = await repository();
    const worktrees = service();
    const parent = await worktrees.create(repo, repo, "recursive-parent");
    cleanupPaths.add(dirname(parent.worktreePath));
    await writeFile(join(parent.worktreePath, "parent-commit.txt"), "parent commit\n");
    await git(parent.worktreePath, "add", "parent-commit.txt");
    await git(parent.worktreePath, "commit", "-m", "parent commit");
    const expectedHead = (await git(parent.worktreePath, "rev-parse", "HEAD")).stdout.trim();
    await makeDirty(parent.worktreePath);
    const originalStatus = await status(parent.worktreePath);

    const child = await worktrees.create(repo, parent.worktreePath, "recursive-child");

    expect(child.parentWorktreePath).toBe(parent.worktreePath);
    expect(child.baseBranch).toBe(parent.branch);
    expect(child.baseCommit).toBe(expectedHead);
    await expectCommittedCheckout(child.worktreePath, expectedHead);
    await expect(readFile(join(child.worktreePath, "parent-commit.txt"), "utf8")).resolves.toBe(
      "parent commit\n",
    );
    await expect(status(parent.worktreePath)).resolves.toBe(originalStatus);
    await expect(readFile(join(parent.worktreePath, "untracked.txt"), "utf8")).resolves.toBe(
      "uncommitted untracked\n",
    );
  });
});
