import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeService } from "../../../src/main/worktree-service";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const storages: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  await Promise.all(storages.splice(0).map((path) => rm(path, { force: true })));
});

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function repository() {
  const path = await mkdtemp(join(tmpdir(), "cake-worktree-repo-"));
  directories.push(path);
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.email", "cake@example.test");
  await git(path, "config", "user.name", "Cake Test");
  await writeFile(join(path, "README.md"), "base\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "base");
  return path;
}

function service(
  storage = join(tmpdir(), `cake-worktree-store-${Math.random().toString(16).slice(2)}.json`),
) {
  storages.push(storage);
  return new WorktreeService(storage);
}

async function commitAll(cwd: string, message: string) {
  await git(cwd, "add", "-A");
  await git(
    cwd,
    "-c",
    "user.email=cake@example.test",
    "-c",
    "user.name=Cake Test",
    "commit",
    "-m",
    message,
  );
}

describe("WorktreeService", () => {
  it("creates a managed worktree outside the repository on an agent branch", async () => {
    const repo = await repository();
    const record = await service().create(repo);
    expect(record.projectPath).toBe(await realpath(repo));
    expect(record.branch).toMatch(/^agent\//);
    expect(record.baseBranch).toBe("main");
    expect(record.worktreePath).toContain(".cake-worktree-repo");
    expect(record.worktreePath.startsWith(repo)).toBe(false);
    expect(existsSync(join(record.worktreePath, "README.md"))).toBe(true);
  });

  it("persists records across service instances", async () => {
    const repo = await repository();
    const storage = join(
      tmpdir(),
      `cake-worktree-store-${Math.random().toString(16).slice(2)}.json`,
    );
    const first = service(storage);
    const record = await first.create(repo);
    const second = service(storage);
    await expect(second.records()).resolves.toEqual([record]);
  });

  it("reports ahead, dirty, and merged state", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);

    const clean = await worktrees.status(record.worktreePath);
    // A fresh worktree points at the base commit, so its branch is contained in main.
    expect(clean).toMatchObject({ dirtyCount: 0, aheadCount: 0, merged: true });

    await writeFile(join(record.worktreePath, "feature.ts"), "export {};\n");
    await commitAll(record.worktreePath, "feature");
    const dirtyFile = join(record.worktreePath, "scratch.txt");
    await writeFile(dirtyFile, "uncommitted\n");
    const status = await worktrees.status(record.worktreePath);
    expect(status).toMatchObject({ dirtyCount: 1, aheadCount: 1, merged: false });
    await rm(dirtyFile);
  });

  it("lands the branch as one squash commit and cleans up", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "export const a = 1;\n");
    await commitAll(record.worktreePath, "feature");

    const outcome = await worktrees.land(record.worktreePath, { autoResolve: true });
    expect(outcome).toEqual({ outcome: "landed", commit: expect.any(String) });

    const log = await git(repo, "log", "--oneline", "main");
    expect(log.stdout).toContain("Merge worktree branch");
    // The work commit is squashed into one commit on top of the base.
    const landedCommits = log.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(landedCommits.length).toBe(2);
    expect(existsSync(record.worktreePath)).toBe(false);
    await expect(git(repo, "rev-parse", "--verify", record.branch)).rejects.toThrow();
    await expect(worktrees.records()).resolves.toEqual([]);
    expect(await service().status(record.worktreePath)).toBeUndefined();
  });

  it("cleans up without merging when there is nothing ahead", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    const outcome = await worktrees.land(record.worktreePath, { autoResolve: true });
    expect(outcome).toEqual({ outcome: "landed" });
    expect(existsSync(record.worktreePath)).toBe(false);
  });

  it("refuses to land a dirty worktree or a dirty canonical checkout", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");

    await writeFile(join(record.worktreePath, "uncommitted.ts"), "x\n");
    await expect(worktrees.land(record.worktreePath, { autoResolve: true })).rejects.toThrow(
      /uncommitted changes/i,
    );
    await rm(join(record.worktreePath, "uncommitted.ts"));

    await writeFile(join(repo, "dirty.ts"), "x\n");
    await expect(worktrees.land(record.worktreePath, { autoResolve: true })).rejects.toThrow(
      /project checkout has uncommitted changes/i,
    );
    await rm(join(repo, "dirty.ts"));
  });

  it("refuses to land while the canonical checkout is on another branch", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");
    await git(repo, "checkout", "-b", "exploration");
    await expect(worktrees.land(record.worktreePath, { autoResolve: true })).rejects.toThrow(
      /back to "main"/i,
    );
    await git(repo, "checkout", "main");
  });

  it("starts a conflict-resolution merge for autoResolve and lands after it is resolved", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);

    await writeFile(join(repo, "shared.txt"), "main version\n");
    await commitAll(repo, "main change");

    await writeFile(join(record.worktreePath, "shared.txt"), "worktree version\n");
    await commitAll(record.worktreePath, "worktree change");

    const outcome = await worktrees.land(record.worktreePath, { autoResolve: true });
    expect(outcome).toEqual({ outcome: "resolving", files: expect.any(Array) });
    // MERGE_HEAD present: the worktree is mid-merge awaiting the agent.
    await expect(
      execFileAsync("git", ["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
        cwd: record.worktreePath,
      }),
    ).resolves.toMatchObject({ stdout: expect.any(String) });

    // The agent resolves the conflict and commits the merge.
    await writeFile(join(record.worktreePath, "shared.txt"), "resolved version\n");
    await commitAll(record.worktreePath, "merge");

    const second = await worktrees.land(record.worktreePath, { autoResolve: true });
    expect(second).toEqual({ outcome: "landed", commit: expect.any(String) });
    expect(await readFileText(join(repo, "shared.txt"))).toBe("resolved version\n");
    expect(existsSync(record.worktreePath)).toBe(false);
  });

  it("reports conflicts without touching the worktree when autoResolve is off", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(repo, "shared.txt"), "main version\n");
    await commitAll(repo, "main change");
    await writeFile(join(record.worktreePath, "shared.txt"), "worktree version\n");
    await commitAll(record.worktreePath, "worktree change");

    const outcome = await worktrees.land(record.worktreePath, { autoResolve: false });
    expect(outcome.outcome).toBe("conflicts");
    if (outcome.outcome === "conflicts" && outcome.files.length > 0)
      expect(outcome.files).toContain("shared.txt");
    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("discards the worktree and optionally keeps the branch", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");

    await worktrees.discard(record.worktreePath, true);
    expect(existsSync(record.worktreePath)).toBe(false);
    await expect(git(repo, "rev-parse", "--verify", record.branch)).resolves.toMatchObject({
      stdout: expect.any(String),
    });
    await expect(worktrees.records()).resolves.toEqual([]);
  });

  it("allows multiple concurrent worktrees per repository", async () => {
    const repo = await repository();
    const worktrees = service();
    const first = await worktrees.create(repo);
    const second = await worktrees.create(repo);

    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(first.branch).not.toBe(second.branch);
    await expect(worktrees.records()).resolves.toHaveLength(2);
    expect(existsSync(join(first.worktreePath, "README.md"))).toBe(true);
    expect(existsSync(join(second.worktreePath, "README.md"))).toBe(true);

    // Each worktree is tracked independently.
    await writeFile(join(first.worktreePath, "feature.ts"), "export {};\n");
    await commitAll(first.worktreePath, "first");
    const firstStatus = await worktrees.status(first.worktreePath);
    const secondStatus = await worktrees.status(second.worktreePath);
    expect(firstStatus).toMatchObject({ aheadCount: 1 });
    expect(secondStatus).toMatchObject({ aheadCount: 0 });
  });

  it("creates a branch-off worktree from another worktree's tip", async () => {
    const repo = await repository();
    const worktrees = service();
    const first = await worktrees.create(repo);
    await writeFile(join(first.worktreePath, "feature.ts"), "export {};\n");
    await commitAll(first.worktreePath, "feature");

    const forked = await worktrees.createBranchOff(first.worktreePath);
    expect(forked.projectPath).toBe(first.projectPath);
    expect(forked.baseBranch).toBe(first.baseBranch);
    expect(forked.branch).not.toBe(first.branch);
    // The branch-off starts at the source worktree's tip, so its file state matches.
    expect(existsSync(join(forked.worktreePath, "feature.ts"))).toBe(true);

    await expect(worktrees.records()).resolves.toHaveLength(2);
    const status = await worktrees.status(forked.worktreePath);
    expect(status).toMatchObject({ aheadCount: 1, dirtyCount: 0 });
  });

  it("drops records for worktree directories deleted outside Cake", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await rm(record.worktreePath, { recursive: true, force: true });

    await expect(worktrees.status(record.worktreePath)).resolves.toBeUndefined();
    await expect(worktrees.records()).resolves.toEqual([]);
    // Git's stale worktree metadata is reconciled so new worktrees keep working.
    const next = await worktrees.create(repo);
    expect(existsSync(join(next.worktreePath, "README.md"))).toBe(true);
  });
});

async function readFileText(path: string) {
  return readFile(path, "utf8");
}
