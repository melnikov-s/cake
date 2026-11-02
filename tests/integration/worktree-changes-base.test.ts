import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeFileSystem } from "@effect/platform-node-shared";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { inspect } from "../../src/domain/worktrees/worktreeChanges";
import { makeGitLive } from "../../src/services/git/GitLive";
import { ProjectAccess } from "../../src/services/projects/ProjectAccess";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Reflog entries have one-second resolution; a fake clock keeps branch creation ordered.
let clock = 1_700_000_000;
async function git(cwd: string, ...args: string[]) {
  const date = `${clock++} +0000`;
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  return (await execFileAsync("git", args, { cwd, env })).stdout.trim();
}

async function commit(cwd: string, message: string) {
  await writeFile(join(cwd, `${message.replaceAll(" ", "-")}.txt`), `${message}\n`);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", message);
}

/** main with one commit; every scenario grows its own branch graph from here. */
async function repository() {
  const path = await mkdtemp(join(tmpdir(), "cake-changes-base-"));
  directories.push(path);
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.email", "cake@example.test");
  await git(path, "config", "user.name", "Cake Test");
  await commit(path, "base");
  return path;
}

async function worktree(repository: string, branch: string, from: string) {
  const path = join(repository, "..", `${repository.split("/").at(-1)}-${branch}`);
  directories.push(path);
  await git(repository, "worktree", "add", "-b", branch, path, from);
  return path;
}

const changes = (path: string, options: { base?: string } = {}) =>
  Effect.runPromise(
    inspect(path, options).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeGitLive(),
          NodeFileSystem.layer,
          Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) }),
          Layer.mock(ManagedWorktrees, { status: () => Effect.succeed(undefined) }),
        ),
      ),
    ),
  );

const subjects = (result: Awaited<ReturnType<typeof changes>>) =>
  result.commits.map((entry) => entry.subject);

describe("Changes base inferred from the Git graph", () => {
  it("shows only a stacked worktree's own commits, not its parent worktree's", async () => {
    const root = await repository();
    const parent = await worktree(root, "agent/parent", "main");
    await commit(parent, "parent one");
    await commit(parent, "parent two");
    const child = await worktree(root, "agent/child", "agent/parent");
    await commit(child, "child one");
    // The parent keeps working after the fork; that must not leak into the child's view.
    await commit(parent, "parent three");

    const result = await changes(child);
    expect(result.base).toBe("agent/parent");
    expect(subjects(result)).toEqual(["child one"]);
    expect(result.totalCommits).toBe(1);

    // The child already contains all of the parent's forked history, so it is no parent.
    const parentView = await changes(parent);
    expect(parentView.base).toBe("main");
    expect(subjects(parentView)).toEqual(["parent three", "parent two", "parent one"]);
  });

  it("infers the real parent when local main is stale instead of comparing with main", async () => {
    const root = await repository();
    const feature = await worktree(root, "feature/upstream", "main");
    for (const index of [1, 2, 3, 4, 5]) await commit(feature, `upstream ${index}`);
    const agent = await worktree(root, "agent/work", "feature/upstream");
    await commit(agent, "agent work");

    const result = await changes(agent);
    expect(result.base).toBe("feature/upstream");
    expect(subjects(result)).toEqual(["agent work"]);
    expect(result.baseAlternatives).toEqual([
      { branch: "feature/upstream", distance: 1 },
      { branch: "main", distance: 6 },
    ]);
  });

  it("prefers a feature branch over main at a shared fork point and lets the user switch", async () => {
    const root = await repository();
    await git(root, "branch", "feature/zeta", "main");
    await git(root, "branch", "feature/alpha", "main");
    const agent = await worktree(root, "agent/tied", "feature/zeta");
    await commit(agent, "tied work");

    const result = await changes(agent);
    expect(result.base).toBe("feature/alpha");
    expect(result.baseAlternatives.map(({ branch }) => branch)).toEqual([
      "feature/alpha",
      "feature/zeta",
      "main",
    ]);

    const switched = await changes(agent, { base: "main" });
    expect(switched.base).toBe("main");
    expect(subjects(switched)).toEqual(["tied work"]);
  });

  it("falls back to the nearest remaining branch when the parent is deleted", async () => {
    const root = await repository();
    const parent = await worktree(root, "agent/parent", "main");
    await commit(parent, "parent work");
    const child = await worktree(root, "agent/child", "agent/parent");
    await commit(child, "child work");
    expect((await changes(child)).base).toBe("agent/parent");

    await git(root, "worktree", "remove", "--force", parent);
    await git(root, "branch", "-D", "agent/parent");

    const result = await changes(child);
    expect(result.base).toBe("main");
    expect(subjects(result)).toEqual(["child work", "parent work"]);
  });

  it("shows no commits for a brand-new child, only its parent as the base", async () => {
    const root = await repository();
    const parent = await worktree(root, "agent/parent", "main");
    await commit(parent, "parent work");
    const child = await worktree(root, "agent/child", "agent/parent");
    // The parent moving on must not turn the empty child into a view of the parent's commits.
    await commit(parent, "parent later");

    const result = await changes(child);
    expect(result.base).toBe("agent/parent");
    expect(result.commits).toEqual([]);
    expect(result.totalCommits).toBe(0);
    // ...and the parent still reviews its own commits rather than comparing with the child.
    expect(subjects(await changes(parent))).toEqual(["parent later", "parent work"]);
  });

  it("uses a fresher remote-tracking trunk but never the branch's own pushed copy", async () => {
    const root = await repository();
    await git(root, "remote", "add", "origin", join(root, "unused-remote"));
    // origin/main has moved on while local main stayed behind.
    await git(root, "update-ref", "refs/remotes/origin/main", "main");
    await git(root, "branch", "--set-upstream-to=origin/main", "main");
    const upstream = await worktree(root, "upstream-tip", "main");
    for (const index of [1, 2, 3]) await commit(upstream, `upstream ${index}`);
    await git(root, "update-ref", "refs/remotes/origin/main", "upstream-tip");
    await git(root, "worktree", "remove", "--force", upstream);
    await git(root, "branch", "-D", "upstream-tip");

    const agent = await worktree(root, "agent/fresh", "origin/main");
    await commit(agent, "agent pushed");
    await git(agent, "update-ref", "refs/remotes/origin/agent/fresh", "HEAD");
    await git(agent, "branch", "--set-upstream-to=origin/agent/fresh");
    await commit(agent, "agent unpushed");

    const result = await changes(agent);
    expect(result.base).toBe("origin/main");
    expect(subjects(result)).toEqual(["agent unpushed", "agent pushed"]);
    expect(result.baseAlternatives.map(({ branch }) => branch)).toEqual(["origin/main", "main"]);
  });

  it("follows a rebase onto a branch created after this one", async () => {
    const root = await repository();
    const agent = await worktree(root, "agent/rebased", "main");
    await commit(agent, "agent work");
    const feature = await worktree(root, "feature/newer", "main");
    await commit(feature, "newer work");
    await git(agent, "rebase", "feature/newer");

    const result = await changes(agent);
    expect(result.base).toBe("feature/newer");
    expect(subjects(result)).toEqual(["agent work"]);
  });

  it("follows a rebase to the new fork point", async () => {
    const root = await repository();
    const agent = await worktree(root, "agent/rebased", "main");
    await commit(agent, "agent work");
    await commit(root, "main moved");
    await git(agent, "rebase", "main");

    const result = await changes(agent);
    expect(result.base).toBe("main");
    expect(subjects(result)).toEqual(["agent work"]);
  });
});
