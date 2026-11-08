import { it } from "@effect/vitest";
import { afterEach, beforeEach, expect } from "vitest";
import { Effect, Layer } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCommitStatsReader } from "../../../src/domain/worktrees/worktreeCommitStats";
import { inspect } from "../../../src/domain/worktrees/worktreeChanges";
import { changeTotals } from "../../../src/contracts/worktrees/worktree-changes";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { Git, GitError } from "../../../src/services/git/Git";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";

let directory: string;
let baseCommit: string;
let commands: ReadonlyArray<string>[];
const run = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const commit = (path: string, content: string) => {
  writeFileSync(join(directory, path), content);
  run("add", ".");
  run("commit", "-m", path);
  return run("rev-parse", "HEAD");
};
const record = (): WorktreeRecord => ({
  projectPath: directory,
  worktreePath: directory,
  branch: "agent/session",
  baseBranch: "release",
  baseCommit,
  createdAt: "",
});
const gitLayer = () =>
  Layer.succeed(
    Git,
    Git.of({
      run: (cwd, args) =>
        Effect.try({
          try: () => {
            commands.push(args);
            return execFileSync("git", [...args], {
              cwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
          },
          catch: (error) =>
            new GitError({
              operation: args.join(" "),
              workingDirectory: cwd,
              message: String(error),
            }),
        }),
    }),
  );
const review = (worktree: WorktreeRecord) =>
  inspect(directory, { base: "not-the-landing-target" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gitLayer(),
        NodeFileSystem.layer,
        Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) }),
        Layer.mock(ManagedWorktrees, {
          status: () =>
            Effect.succeed({
              record: worktree,
              targetBranch: worktree.baseBranch,
              dirtyCount: 0,
              aheadCount: 0,
              behindCount: 0,
              merged: false,
              targetDirty: false,
              targetOnBranch: true,
              merging: false,
              rebasing: false,
              squashMessageReady: false,
            }),
        }),
      ),
    ),
  );
const expectReview = Effect.fn("test.expectReview")(function* (
  worktree: WorktreeRecord,
  count: number,
  additions: number,
  deletions: number,
  paths: string[],
) {
  const data = yield* review(worktree);
  expect(data.base).toBe(worktree.baseBranch);
  expect(data.baseAlternatives).toEqual([]);
  expect(data.totalCommits).toBe(count);
  expect(changeTotals(data.files)).toEqual({ additions, deletions, binary: 0 });
  expect(data.files.map((file) => file.path).sort()).toEqual(paths.sort());
  expect(data.headRevision).toBe(run("rev-parse", "HEAD"));
  return data;
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cake-commit-stats-"));
  commands = [];
  run("init", "-b", "release");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  baseCommit = commit("file.txt", "base\nold\n");
  run("checkout", "-b", "agent/session");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.effect(
  "excludes six inherited commits already on the configured target, not the frozen start",
  () =>
    Effect.gen(function* () {
      for (let i = 0; i < 6; i++) commit(`inherited-${i}.txt`, "inherited\n");
      run("branch", "-f", "release", "HEAD");
      commit("file.txt", "base\nnew\nextra\n");
      const read = yield* makeCommitStatsReader().pipe(Effect.provide(gitLayer()));
      expect(yield* read(record())).toEqual({ commitCount: 1, additions: 2, deletions: 1 });
      const data = yield* expectReview(record(), 1, 2, 1, ["file.txt"]);
      expect(data.baseRevision).toBe(run("merge-base", "release", "HEAD"));
      expect(run("diff", "--name-only", "release...HEAD")).toBe("file.txt");
    }),
);

it.effect("keeps inherited commits that are genuinely absent from a behind target", () =>
  Effect.gen(function* () {
    commit("inherited.txt", "not landed\n");
    const taskStart = run("rev-parse", "HEAD");
    commit("task.txt", "task\n");
    const worktree = { ...record(), baseCommit: taskStart };
    const read = yield* makeCommitStatsReader().pipe(Effect.provide(gitLayer()));
    expect(yield* read(worktree)).toEqual({ commitCount: 2, additions: 2, deletions: 0 });
    yield* expectReview(worktree, 2, 2, 0, ["inherited.txt", "task.txt"]);
  }),
);

it.effect(
  "uses the merge-base for a diverged target, excluding target-only changes and dirty work",
  () =>
    Effect.gen(function* () {
      commit("file.txt", "base\nnew\nextra\n");
      run("checkout", "release");
      commit("target-only.txt", "unrelated\n");
      run("checkout", "agent/session");
      writeFileSync(join(directory, "file.txt"), "dirty\n");
      const read = yield* makeCommitStatsReader().pipe(Effect.provide(gitLayer()));
      expect(yield* read(record())).toEqual({ commitCount: 1, additions: 2, deletions: 1 });
      const data = yield* expectReview(record(), 1, 2, 1, ["file.txt"]);
      expect(data.unstaged).toHaveLength(1);
      expect(data.baseRevision).toBe(baseCommit);
    }),
);

it.effect(
  "resolves changed targets and target advancement even when the source tip is cached",
  () =>
    Effect.gen(function* () {
      commit("first.txt", "first\n");
      run("branch", "integration");
      commit("second.txt", "second\n");
      const read = yield* makeCommitStatsReader().pipe(Effect.provide(gitLayer()));
      expect(yield* read(record())).toEqual({ commitCount: 2, additions: 2, deletions: 0 });
      expect(yield* read(record())).toEqual({ commitCount: 2, additions: 2, deletions: 0 });
      expect(commands.filter((args) => args[0] === "diff")).toHaveLength(1);
      const changed = { ...record(), baseBranch: "integration" };
      expect(yield* read(changed)).toEqual({ commitCount: 1, additions: 1, deletions: 0 });
      yield* expectReview(changed, 1, 1, 0, ["second.txt"]);
      run("branch", "-f", "release", "HEAD");
      expect(yield* read(record())).toEqual({ commitCount: 0, additions: 0, deletions: 0 });
      yield* expectReview(record(), 0, 0, 0, []);
      run("checkout", "release");
      commit("later.txt", "target ahead\n");
      run("checkout", "agent/session");
      expect(yield* read(record())).toEqual({ commitCount: 0, additions: 0, deletions: 0 });
      yield* expectReview(record(), 0, 0, 0, []);
    }),
);

it.effect("reports a net file delta, not the sum of historical commit edits", () =>
  Effect.gen(function* () {
    commit("file.txt", "temporary\n");
    commit("file.txt", "base\nold\n");
    const read = yield* makeCommitStatsReader().pipe(Effect.provide(gitLayer()));
    expect(yield* read(record())).toEqual({ commitCount: 2, additions: 0, deletions: 0 });
    const data = yield* expectReview(record(), 2, 0, 0, []);
    expect(changeTotals(data.commits.flatMap((entry) => entry.files)).additions).toBeGreaterThan(0);
  }),
);

it.effect(
  "shows zero after squash landing and only fresh changes after its acknowledged checkpoint",
  () =>
    Effect.gen(function* () {
      const landedSourceCommit = commit("task.txt", "landed\n");
      run("checkout", "release");
      run("merge", "--squash", "agent/session");
      run("commit", "-m", "Squash task");
      run("checkout", "agent/session");
      const worktree = { ...record(), landedSourceCommit, state: "landed" as const };
      const read = yield* makeCommitStatsReader().pipe(Effect.provide(gitLayer()));
      expect(yield* read(worktree)).toEqual({ commitCount: 0, additions: 0, deletions: 0 });
      yield* expectReview(worktree, 0, 0, 0, []);
      commit("task.txt", "landed\nfresh\n");
      expect(yield* read(worktree)).toEqual({ commitCount: 1, additions: 1, deletions: 0 });
      yield* expectReview(worktree, 1, 1, 0, ["task.txt"]);
      // Rewriting the source away from the checkpoint must not compare unrelated trees.
      run("reset", "--hard", baseCommit);
      commit("different.txt", "different\n");
      expect(yield* read(worktree)).toEqual({ commitCount: 1, additions: 1, deletions: 0 });
      yield* expectReview(worktree, 1, 1, 0, ["different.txt"]);
    }),
);

it.effect(
  "does not require a frozen start and never falls back to it for unavailable target refs",
  () =>
    Effect.gen(function* () {
      commit("task.txt", "task\n");
      const read = yield* makeCommitStatsReader().pipe(Effect.provide(gitLayer()));
      expect(yield* read({ ...record(), baseCommit: undefined })).toEqual({
        commitCount: 1,
        additions: 1,
        deletions: 0,
      });
      expect(yield* read({ ...record(), baseCommit: "unavailable" })).toEqual({
        commitCount: 1,
        additions: 1,
        deletions: 0,
      });
      expect(yield* read({ ...record(), baseBranch: "missing" })).toBeUndefined();
      expect(yield* read({ ...record(), branch: "missing" })).toBeUndefined();
    }),
);

it.effect("uses the full uncapped range count and excludes binary line counts", () =>
  Effect.gen(function* () {
    const read = yield* makeCommitStatsReader().pipe(
      Effect.provideService(
        Git,
        Git.of({
          run: (_, args) => {
            commands.push(args);
            return Effect.succeed(
              args[0] === "rev-parse"
                ? "tip\n"
                : args[0] === "merge-base"
                  ? "base\n"
                  : args[0] === "rev-list"
                    ? "250\n"
                    : "120\t35\tcode.ts\0-\t-\timage.png\0",
            );
          },
        }),
      ),
    );
    expect(yield* read(record())).toEqual({ commitCount: 250, additions: 120, deletions: 35 });
    expect(commands.find((args) => args[0] === "rev-list")).toEqual([
      "rev-list",
      "--count",
      "tip",
      "^tip",
      "^base",
      "--",
    ]);
    expect(commands.some((args) => args[0] === "log")).toBe(false);
  }),
);
