import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestWorktreeStorageRepository } from "../helpers/worktree-storage-repository";
import { ManagedWorktreeEngine } from "../../src/services/worktrees/ManagedWorktreeEngine";

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
  return new ManagedWorktreeEngine(
    makeTestWorktreeStorageRepository(storage),
    async (workingDirectory, arguments_) =>
      (await execFileAsync("git", [...arguments_], { cwd: workingDirectory, maxBuffer: 4_000_000 }))
        .stdout,
  );
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

describe("WorktreeService", { timeout: 20_000 }, () => {
  it("creates a managed worktree outside the repository on an agent branch", async () => {
    const repo = await repository();
    const record = await service().create(repo);
    expect(record.projectPath).toBe(repo);
    expect(record.branch).toMatch(/^agent\//);
    expect(record.baseBranch).toBe("main");
    expect(record.worktreePath).toContain(".cake-worktree-repo");
    expect(record.worktreePath.startsWith(repo)).toBe(false);
    expect(existsSync(join(record.worktreePath, "README.md"))).toBe(true);
  });

  it("preserves the registered project path when Git resolves through a filesystem alias", async () => {
    const repo = await repository();
    const aliasRoot = await mkdtemp(join(tmpdir(), "cake-worktree-alias-"));
    directories.push(aliasRoot);
    const alias = join(aliasRoot, "project");
    await symlink(repo, alias);
    const worktrees = service();

    const record = await worktrees.create(alias, undefined, "aliased-project");

    expect(record.projectPath).toBe(alias);
    await worktrees.discard(record.worktreePath, false);
  });

  it("uses an explicit worktree name for its branch and checkout", async () => {
    const repo = await repository();
    const record = await service().create(repo, undefined, "focused-fix");

    expect(record.branch).toBe("agent/focused-fix");
    expect(record.worktreePath).toMatch(/\/focused-fix$/);
    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("branches a child worktree from a landed worktree", async () => {
    const repo = await repository();
    const worktrees = service();
    const parent = await worktrees.create(repo, undefined, "landed-parent");
    await worktrees.land(parent.worktreePath, { request: { strategy: "preserve" } });

    const child = await worktrees.create(repo, parent.worktreePath, "continued-child");

    expect(child.parentWorktreePath).toBe(parent.worktreePath);
    expect(child.baseBranch).toBe(parent.branch);
    await worktrees.discard(child.worktreePath, false);
    await worktrees.discard(parent.worktreePath, false);
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
    expect(clean).toMatchObject({ dirtyCount: 0, aheadCount: 0, behindCount: 0, merged: true });

    await writeFile(join(record.worktreePath, "feature.ts"), "export {};\n");
    await commitAll(record.worktreePath, "feature");
    const dirtyFile = join(record.worktreePath, "scratch.txt");
    await writeFile(dirtyFile, "uncommitted\n");
    const status = await worktrees.status(record.worktreePath);
    expect(status).toMatchObject({ dirtyCount: 1, aheadCount: 1, merged: false });
    await rm(dirtyFile);
  });

  it("preserves commits and their hashes when landing onto an unchanged target", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "export const a = 1;\n");
    await commitAll(record.worktreePath, "feature one");
    await writeFile(join(record.worktreePath, "feature-2.ts"), "export const b = 2;\n");
    await commitAll(record.worktreePath, "feature two");
    const worktreeHead = (await git(record.worktreePath, "rev-parse", "HEAD")).stdout.trim();

    const outcome = await worktrees.land(record.worktreePath, {
      request: { strategy: "preserve" },
    });
    expect(outcome).toEqual({ outcome: "landed", commit: worktreeHead });

    const log = await git(repo, "log", "--oneline", "main");
    expect(log.stdout).toContain("feature one");
    expect(log.stdout).toContain("feature two");
    // The target had not moved, so the original commits were fast-forwarded verbatim.
    expect((await git(repo, "rev-parse", "main")).stdout.trim()).toBe(worktreeHead);
    expect(existsSync(record.worktreePath)).toBe(true);
    await expect(git(repo, "rev-parse", "--verify", record.branch)).resolves.toBeDefined();
    await expect(worktrees.records()).resolves.toEqual([
      expect.objectContaining({ worktreePath: record.worktreePath, state: "landed" }),
    ]);
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      merged: true,
      record: { state: "landed" },
    });
  });

  it("rebases deterministically when the target branch advances", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "export const feature = true;\n");
    await commitAll(record.worktreePath, "feature");
    const originalHead = (await git(record.worktreePath, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(repo, "main.ts"), "export const main = true;\n");
    await commitAll(repo, "main moves");

    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({ behindCount: 1 });
    await expect(worktrees.rebase(record.worktreePath)).resolves.toEqual({ outcome: "rebased" });
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({ behindCount: 0 });

    const rebasedHead = (await git(record.worktreePath, "rev-parse", "HEAD")).stdout.trim();
    expect(rebasedHead).not.toBe(originalHead);
    expect((await git(record.worktreePath, "log", "--format=%s", "-2")).stdout).toBe(
      "feature\nmain moves\n",
    );
  });

  it("pauses a standalone rebase for agent conflict resolution", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "README.md"), "worktree\n");
    await commitAll(record.worktreePath, "feature");
    await writeFile(join(repo, "README.md"), "main\n");
    await commitAll(repo, "main moves");

    await expect(worktrees.rebase(record.worktreePath)).resolves.toEqual({
      outcome: "resolving",
      files: ["README.md"],
    });
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({ rebasing: true });
  });

  it("replays commits on top of an advanced target when preserving", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "export const a = 1;\n");
    await commitAll(record.worktreePath, "feature");
    await writeFile(join(repo, "main.ts"), "export const main = true;\n");
    await commitAll(repo, "main moves");

    const outcome = await worktrees.land(record.worktreePath, {
      request: { strategy: "preserve" },
    });
    expect(outcome).toEqual({ outcome: "landed", commit: expect.any(String) });

    const log = await git(repo, "log", "--oneline", "main");
    expect(log.stdout).toContain("main moves");
    expect(log.stdout).toContain("feature");
    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("squashes into one commit with an explicit message and retains the checkout", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "export const a = 1;\n");
    await commitAll(record.worktreePath, "feature");

    const outcome = await worktrees.land(record.worktreePath, {
      request: { strategy: "squash", message: "Squashed feature" },
    });
    expect(outcome).toEqual({ outcome: "landed", commit: expect.any(String) });

    const log = await git(repo, "log", "--oneline", "main");
    expect(log.stdout).toContain("Squashed feature");
    // The work commits are squashed into one commit on top of the base.
    const landedCommits = log.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(landedCommits.length).toBe(2);
    expect(existsSync(record.worktreePath)).toBe(true);
    await expect(git(repo, "rev-parse", "--verify", record.branch)).resolves.toBeDefined();
    await expect(worktrees.records()).resolves.toEqual([
      expect.objectContaining({ worktreePath: record.worktreePath, state: "landed" }),
    ]);
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      merged: true,
      record: { state: "landed" },
    });
  });

  it("pauses squash landing until the session agent proposes a commit message", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "export const a = 1;\n");
    await commitAll(record.worktreePath, "feature");

    await expect(
      worktrees.proposeSquashMessage({
        workspacePath: record.worktreePath,
        subject: "unsolicited",
      }),
    ).rejects.toThrow(/no worktree landing is waiting/i);

    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      squashMessageReady: false,
      record: { pendingStrategy: "squash" },
    });

    // A proposal for an older branch tip must not satisfy the landing.
    await writeFile(join(record.worktreePath, "extra.ts"), "export const e = 1;\n");
    await commitAll(record.worktreePath, "extra");
    await worktrees.proposeSquashMessage({
      workspacePath: record.worktreePath,
      subject: "stale subject",
    });
    await writeFile(join(record.worktreePath, "more.ts"), "export const m = 1;\n");
    await commitAll(record.worktreePath, "more");
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });

    await worktrees.proposeSquashMessage({
      workspacePath: record.worktreePath,
      subject: "Combined feature",
      body: "Squashed from the worktree branch.",
    });
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      squashMessageReady: true,
    });
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "landed", commit: expect.any(String) });
    const message = await git(repo, "log", "-1", "--pretty=%B");
    expect(message.stdout).toContain("Combined feature");
    expect(message.stdout).toContain("Squashed from the worktree branch.");
    expect(existsSync(record.worktreePath)).toBe(true);
    const [landed] = await worktrees.records();
    expect(landed).toBeDefined();
    expect(landed!.pendingStrategy).toBeUndefined();
  });

  it("clears a pending squash proposal when the worktree is discarded", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });

    await worktrees.discard(record.worktreePath, false);
    await expect(
      worktrees.proposeSquashMessage({
        workspacePath: record.worktreePath,
        subject: "too late",
      }),
    ).rejects.toThrow();
  });

  it("marks the worktree landed without cleanup when there is nothing ahead", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    const outcome = await worktrees.land(record.worktreePath, {
      request: { strategy: "squash" },
    });
    expect(outcome).toEqual({ outcome: "landed" });
    expect(existsSync(record.worktreePath)).toBe(true);
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      merged: true,
      record: { state: "landed" },
    });
  });

  it("refuses to land a dirty worktree or a dirty canonical checkout", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");

    await writeFile(join(record.worktreePath, "uncommitted.ts"), "x\n");
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).rejects.toThrow(/uncommitted changes/i);
    await rm(join(record.worktreePath, "uncommitted.ts"));

    await writeFile(join(repo, "dirty.ts"), "x\n");
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).rejects.toThrow(/landing target has uncommitted changes/i);
    await rm(join(repo, "dirty.ts"));
  });

  it("lands after the user confirms a dirty target and preserves its changes", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "feature\n");
    await commitAll(record.worktreePath, "feature");
    await writeFile(join(repo, "in-progress.ts"), "target change\n");

    await expect(
      worktrees.land(record.worktreePath, {
        request: { strategy: "preserve", allowDirtyTarget: true },
      }),
    ).resolves.toMatchObject({ outcome: "landed" });
    await expect(readFile(join(repo, "feature.ts"), "utf8")).resolves.toBe("feature\n");
    await expect(readFile(join(repo, "in-progress.ts"), "utf8")).resolves.toBe("target change\n");
  });

  it("refuses to land while the canonical checkout is on another branch", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");
    await git(repo, "checkout", "-b", "exploration");
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).rejects.toThrow(/back to "main"/i);
    await git(repo, "checkout", "main");
  });

  it("pauses on rebase conflicts for preserve landing and lands after the agent resolves them", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);

    await writeFile(join(repo, "shared.txt"), "main version\n");
    await commitAll(repo, "main change");

    await writeFile(join(record.worktreePath, "shared.txt"), "worktree version\n");
    await commitAll(record.worktreePath, "worktree change");

    const outcome = await worktrees.land(record.worktreePath, {
      request: { strategy: "preserve" },
    });
    expect(outcome).toEqual({ outcome: "resolving", files: ["shared.txt"] });
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      rebasing: true,
      merging: false,
      record: { pendingStrategy: "preserve" },
    });

    // The agent resolves the conflict and continues the rebase without opening an editor.
    await writeFile(join(record.worktreePath, "shared.txt"), "resolved version\n");
    await execFileAsync("git", ["add", "-A"], { cwd: record.worktreePath });
    await execFileAsync("git", ["rebase", "--continue"], {
      cwd: record.worktreePath,
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      rebasing: false,
      dirtyCount: 0,
    });

    const second = await worktrees.land(record.worktreePath, {
      request: { strategy: "preserve" },
    });
    expect(second).toEqual({ outcome: "landed", commit: expect.any(String) });
    expect(await readFileText(join(repo, "shared.txt"))).toBe("resolved version\n");
    const log = await git(repo, "log", "--oneline", "main");
    expect(log.stdout).toContain("worktree change");
    expect(existsSync(record.worktreePath)).toBe(true);
    const [landed] = await worktrees.records();
    expect(landed).toBeDefined();
    expect(landed!.pendingStrategy).toBeUndefined();
  });

  it("pauses squash landing on conflicts, then lands after the agent resolves and proposes", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);

    await writeFile(join(repo, "shared.txt"), "main version\n");
    await commitAll(repo, "main change");

    await writeFile(join(record.worktreePath, "shared.txt"), "worktree version\n");
    await commitAll(record.worktreePath, "worktree change");

    const outcome = await worktrees.land(record.worktreePath, {
      request: { strategy: "squash" },
    });
    expect(outcome.outcome).toBe("resolving");
    if (outcome.outcome === "resolving") expect(outcome.files).toContain("shared.txt");
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      merging: true,
      rebasing: false,
      squashMessageReady: false,
      record: { pendingStrategy: "squash" },
    });

    // Proposing before the merge is completed is rejected so the message
    // always describes the resolved result.
    await expect(
      worktrees.proposeSquashMessage({ workspacePath: record.worktreePath, subject: "early" }),
    ).rejects.toThrow(/in-progress merge/i);

    // The agent resolves the conflict, commits the temporary merge, and proposes the message.
    await writeFile(join(record.worktreePath, "shared.txt"), "resolved version\n");
    await commitAll(record.worktreePath, "merge");
    await worktrees.proposeSquashMessage({
      workspacePath: record.worktreePath,
      subject: "Combined worktree change",
    });

    const second = await worktrees.land(record.worktreePath, {
      request: { strategy: "squash" },
    });
    expect(second).toEqual({ outcome: "landed", commit: expect.any(String) });
    expect(await readFileText(join(repo, "shared.txt"))).toBe("resolved version\n");
    const message = await git(repo, "log", "-1", "--pretty=%B");
    expect(message.stdout).toContain("Combined worktree change");
    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("keeps the landing target clean when an explicit squash message hits conflicts", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);

    await writeFile(join(repo, "shared.txt"), "main version\n");
    await commitAll(repo, "main change");
    await writeFile(join(record.worktreePath, "shared.txt"), "worktree version\n");
    await commitAll(record.worktreePath, "worktree change");

    const outcome = await worktrees.land(record.worktreePath, {
      request: { strategy: "squash", message: "user message" },
    });
    expect(outcome.outcome).toBe("resolving");
    // The conflicted squash must never run against the target checkout.
    expect((await git(repo, "status", "--porcelain")).stdout.trim()).toBe("");

    // The agent resolves, but the explicit message was bound to the
    // pre-resolution tip, so landing re-asks for a proposal that describes the
    // resolved result.
    await writeFile(join(record.worktreePath, "shared.txt"), "resolved version\n");
    await commitAll(record.worktreePath, "merge");
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "proposal" });

    await worktrees.proposeSquashMessage({
      workspacePath: record.worktreePath,
      subject: "Resolved combined change",
    });
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "landed", commit: expect.any(String) });
    await expect(git(repo, "log", "-1", "--pretty=%B")).resolves.toMatchObject({
      stdout: expect.stringContaining("Resolved combined change"),
    });
    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("re-pauses for resolution instead of squashing when the target moves after the proposal", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);

    await writeFile(join(repo, "shared.txt"), "main version\n");
    await commitAll(repo, "main change");
    await writeFile(join(record.worktreePath, "shared.txt"), "worktree version\n");
    await commitAll(record.worktreePath, "worktree change");

    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toMatchObject({ outcome: "resolving" });
    await writeFile(join(record.worktreePath, "shared.txt"), "resolved version\n");
    await commitAll(record.worktreePath, "merge");
    await worktrees.proposeSquashMessage({
      workspacePath: record.worktreePath,
      subject: "First proposal",
    });
    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      squashMessageReady: true,
    });

    // The target advances with a conflicting commit after the proposal.
    await writeFile(join(repo, "shared.txt"), "rival main version\n");
    await commitAll(repo, "rival main change");

    // The stale proposal must not be squashed into the moved target.
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toMatchObject({ outcome: "resolving" });
    expect((await git(repo, "status", "--porcelain")).stdout.trim()).toBe("");

    // Resolving against the new target tip completes the landing.
    await writeFile(join(record.worktreePath, "shared.txt"), "final version\n");
    await commitAll(record.worktreePath, "second merge");
    await worktrees.proposeSquashMessage({
      workspacePath: record.worktreePath,
      subject: "Final proposal",
    });
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toEqual({ outcome: "landed", commit: expect.any(String) });
    expect(await readFileText(join(repo, "shared.txt"))).toBe("final version\n");
    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("resumes resolving instead of failing when a landing is retried mid-rebase", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);

    await writeFile(join(repo, "shared.txt"), "main version\n");
    await commitAll(repo, "main change");
    await writeFile(join(record.worktreePath, "shared.txt"), "worktree version\n");
    await commitAll(record.worktreePath, "worktree change");

    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).resolves.toMatchObject({ outcome: "resolving" });

    // Retrying either strategy while the rebase is paused resumes resolution
    // instead of failing on the dirty mid-rebase worktree.
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).resolves.toMatchObject({ outcome: "resolving" });
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "squash" } }),
    ).resolves.toMatchObject({ outcome: "resolving" });

    // Finishing the rebase lets the preserve landing complete.
    await writeFile(join(record.worktreePath, "shared.txt"), "resolved version\n");
    await execFileAsync("git", ["add", "-A"], { cwd: record.worktreePath });
    await execFileAsync("git", ["rebase", "--continue"], {
      cwd: record.worktreePath,
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    await expect(
      worktrees.land(record.worktreePath, { request: { strategy: "preserve" } }),
    ).resolves.toEqual({ outcome: "landed", commit: expect.any(String) });
    expect(existsSync(record.worktreePath)).toBe(true);
  });

  it("discards a landed worktree during explicit cleanup", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");
    await worktrees.land(record.worktreePath, { request: { strategy: "preserve" } });

    await expect(worktrees.status(record.worktreePath)).resolves.toMatchObject({
      record: { state: "landed" },
    });
    await worktrees.discard(record.worktreePath, false);

    expect(existsSync(record.worktreePath)).toBe(false);
    await expect(git(repo, "rev-parse", "--verify", record.branch)).rejects.toThrow();
    await expect(worktrees.status(record.worktreePath)).resolves.toBeUndefined();
  });

  it("removes a resolved landed worktree and recreates it when restored", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");
    await worktrees.land(record.worktreePath, { request: { strategy: "preserve" } });

    await worktrees.cleanupResolved(record.worktreePath);

    expect(existsSync(record.worktreePath)).toBe(false);
    await expect(git(repo, "rev-parse", "--verify", record.branch)).rejects.toThrow();
    await expect(worktrees.records()).resolves.toEqual([
      expect.objectContaining({ worktreePath: record.worktreePath, state: "resolved" }),
    ]);

    await expect(worktrees.restoreResolved(record.worktreePath)).resolves.toMatchObject({
      state: "active",
    });
    expect(existsSync(record.worktreePath)).toBe(true);
    await expect(
      git(record.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"),
    ).resolves.toMatchObject({ stdout: expect.stringContaining(record.branch) });
  });

  it("restores a worktree when restoration is requested during resolved cleanup", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await writeFile(join(record.worktreePath, "feature.ts"), "x\n");
    await commitAll(record.worktreePath, "feature");
    await worktrees.land(record.worktreePath, { request: { strategy: "preserve" } });

    const cleanup = worktrees.cleanupResolved(record.worktreePath);
    const restoration = worktrees.restoreResolved(record.worktreePath);

    await cleanup;
    await expect(restoration).resolves.toMatchObject({ state: "active" });
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
    await expect(worktrees.records()).resolves.toEqual([
      expect.objectContaining({ worktreePath: record.worktreePath, state: "discarded" }),
    ]);
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
    expect(forked.baseBranch).toBe(first.branch);
    expect(forked.parentWorktreePath).toBe(first.worktreePath);
    expect(forked.branch).not.toBe(first.branch);
    // The branch-off starts at the source worktree's tip, so its file state matches.
    expect(existsSync(join(forked.worktreePath, "feature.ts"))).toBe(true);

    await expect(worktrees.records()).resolves.toHaveLength(2);
    const status = await worktrees.status(forked.worktreePath);
    expect(status).toMatchObject({ aheadCount: 0, dirtyCount: 0 });
  });

  it("lands a stacked child into its parent worktree before the parent lands to main", async () => {
    const repo = await repository();
    const worktrees = service();
    const parent = await worktrees.create(repo);
    await writeFile(join(parent.worktreePath, "parent.ts"), "parent\n");
    await commitAll(parent.worktreePath, "parent");
    const child = await worktrees.create(repo, parent.worktreePath);
    await writeFile(join(child.worktreePath, "child.ts"), "child\n");
    await commitAll(child.worktreePath, "child");

    await expect(
      worktrees.land(parent.worktreePath, { request: { strategy: "preserve" } }),
    ).rejects.toThrow(/active child worktrees/i);
    await expect(
      worktrees.land(child.worktreePath, { request: { strategy: "preserve" } }),
    ).resolves.toMatchObject({
      outcome: "landed",
    });
    expect(existsSync(join(parent.worktreePath, "child.ts"))).toBe(true);
    expect(existsSync(join(repo, "child.ts"))).toBe(false);

    await expect(
      worktrees.land(parent.worktreePath, { request: { strategy: "preserve" } }),
    ).resolves.toMatchObject({
      outcome: "landed",
    });
    expect(existsSync(join(repo, "parent.ts"))).toBe(true);
    expect(existsSync(join(repo, "child.ts"))).toBe(true);
  });

  it("marks worktree directories deleted outside Cake as missing", async () => {
    const repo = await repository();
    const worktrees = service();
    const record = await worktrees.create(repo);
    await rm(record.worktreePath, { recursive: true, force: true });

    await expect(worktrees.status(record.worktreePath)).resolves.toBeUndefined();
    await expect(worktrees.records()).resolves.toEqual([
      expect.objectContaining({ worktreePath: record.worktreePath, state: "missing" }),
    ]);
    // Git's stale worktree metadata is reconciled so new worktrees keep working.
    const next = await worktrees.create(repo);
    expect(existsSync(join(next.worktreePath, "README.md"))).toBe(true);
  });
});

async function readFileText(path: string) {
  return readFile(path, "utf8");
}
