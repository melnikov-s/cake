import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeTestWorktreeService, type TestWorktreeService } from "../helpers/worktree-service";
import { makeGitLive } from "../../src/services/git/GitLive";
import { makeContributionStatsReader } from "../../src/domain/worktrees/worktreeContributionStats";

const directories: string[] = [];
const services: TestWorktreeService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, path: string, text: string) => {
  writeFileSync(join(cwd, path), text);
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", path);
};
const createService = (storage: string) => {
  const service = makeTestWorktreeService(storage);
  services.push(service);
  return service;
};

it.each(["preserve", "squash"] as const)(
  "persists contribution through managed %s landing, restart, retirement, Git GC, and restore",
  async (strategy) => {
    const directory = mkdtempSync(join(tmpdir(), "cake-contribution-lifecycle-"));
    directories.push(directory);
    const project = join(directory, "project");
    git(directory, "init", "-b", "main", project);
    git(project, "config", "user.name", "Test");
    git(project, "config", "user.email", "test@example.com");
    commit(project, "base.txt", "base\n");
    const storage = join(directory, "worktrees.json");
    let service = createService(storage);
    const created = await service.create(project);
    expect(created.contributionRef).toMatch(/^refs\/cake\/contributions\//);
    const readStats = await Effect.runPromise(
      makeContributionStatsReader().pipe(Effect.provide(makeGitLive())),
    );
    const stats = async () => {
      const record = (await service.records()).find(
        (record) => record.worktreePath === created.worktreePath,
      );
      if (!record) throw new Error("Record missing");
      return Effect.runPromise(readStats(record));
    };
    const expected = (additions: number) => ({ additions, deletions: 0, unavailableReason: null });
    commit(created.worktreePath, "task.txt", "task\n");
    commit(project, "upstream.txt", "upstream\n");
    await service.rebase(created.worktreePath);
    expect(await stats()).toEqual(expected(1));
    await service.land(created.worktreePath, { request: { strategy, message: "land task" } });
    expect(await stats()).toEqual(expected(1));
    await service.dispose();
    services.splice(services.indexOf(service), 1);
    service = createService(storage);
    expect(await stats()).toEqual(expected(1));
    const stored = JSON.parse(readFileSync(storage, "utf8"));
    expect(stored.records[0].contributionRef).toBe(created.contributionRef);
    commit(created.worktreePath, "task.txt", "task\nfresh\n");
    commit(project, "later-upstream.txt", "later upstream\n");
    await service.land(created.worktreePath, { request: { strategy, message: "land follow-up" } });
    expect(await stats()).toEqual(expected(2));
    await service.cleanupResolved(created.worktreePath);
    expect(await stats()).toEqual(expected(2));
    git(project, "reflog", "expire", "--expire=now", "--all");
    git(project, "gc", "--prune=now");
    expect(await stats()).toEqual(expected(2));
    commit(project, "after-retirement.txt", "upstream after retirement\n");
    await service.restoreResolved(created.worktreePath);
    expect(await stats()).toEqual(expected(2));
    commit(created.worktreePath, "task.txt", "task\nfresh\nnew work\n");
    expect(await stats()).toEqual(expected(3));
    await service.discard(created.worktreePath, false);
  },
  30_000,
);
