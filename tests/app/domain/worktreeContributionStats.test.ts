import { it } from "@effect/vitest";
import { afterEach, beforeEach, expect } from "vitest";
import { Effect, Layer } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContributionStatsReader } from "../../../src/domain/worktrees/worktreeContributionStats";
import { inspect } from "../../../src/domain/worktrees/worktreeChanges";
import { changeTotals } from "../../../src/contracts/worktrees/worktree-changes";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { Git, GitError } from "../../../src/services/git/Git";
import {
  makeContributionRepository,
  retainContribution,
} from "../../../src/services/worktrees/WorktreeContribution";
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
  contributionRef: "refs/cake/contributions/test",
  createdAt: "",
});
const gitService = () =>
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
            operation: `git ${args.join(" ")}`,
            workingDirectory: cwd,
            message: String(error),
          }),
      }),
  });
const fixture = Effect.fn("test.fixture")(function* () {
  const git = gitService();
  const repository = makeContributionRepository(directory, git);
  const worktree = record();
  yield* repository.initialize("refs/cake/contributions/test", baseCommit);
  const stats = yield* makeContributionStatsReader().pipe(Effect.provideService(Git, git));
  const review = () =>
    inspect(directory, {}).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Git, git),
          NodeFileSystem.layer,
          Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) }),
          Layer.mock(ManagedWorktrees, {
            status: () =>
              Effect.succeed({
                record: worktree,
                targetBranch: "release",
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
  const expectTotals = Effect.fn("test.expectTotals")(function* (
    additions: number,
    deletions: number,
    paths: string[],
  ) {
    expect(yield* stats(worktree)).toEqual({ additions, deletions, unavailableReason: null });
    const data = yield* review();
    expect(data.contributionUnavailableReason).toBeNull();
    expect(changeTotals(data.files)).toMatchObject({ additions, deletions });
    expect(data.files.map((file) => file.path).sort()).toEqual(paths.toSorted());
    expect(data.headRevision).toBe(run("rev-parse", "HEAD"));
    expect(
      run("diff", "--name-only", data.baseRevision ?? "", data.headRevision)
        .split("\n")
        .filter(Boolean)
        .sort(),
    ).toEqual(paths.toSorted());
    return data;
  });
  return { repository, worktree, stats, review, expectTotals, git };
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cake-contribution-"));
  commands = [];
  run("init", "-b", "release");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  baseCommit = commit("file.txt", "base\nold\n");
  run("checkout", "-b", "agent/session");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.effect(
  "counts branch-local additions/removals, cancellation across commits, and excludes dirty edits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("file.txt", "base\nnew\nextra\n");
      yield* f.expectTotals(2, 1, ["file.txt"]);
      commit("temporary.txt", "temporary\n");
      run("rm", "temporary.txt");
      run("commit", "-m", "cancel temporary");
      yield* f.expectTotals(2, 1, ["file.txt"]);
      commit("file.txt", "base\nold\n");
      writeFileSync(join(directory, "file.txt"), "staged\n");
      run("add", "file.txt");
      writeFileSync(join(directory, "file.txt"), "unstaged\n");
      writeFileSync(join(directory, "new.txt"), "untracked\n");
      const data = yield* f.expectTotals(0, 0, []);
      expect(data.staged).toHaveLength(1);
      expect(data.unstaged).toHaveLength(2);
      expect(changeTotals(data.commits.flatMap((entry) => entry.files)).additions).toBeGreaterThan(
        0,
      );
    }),
);

it.effect(
  "unrelated target advances and changing the landing target do not erase contribution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("task.txt", "task\n");
      run("checkout", "release");
      commit("upstream.txt", "upstream\n");
      run("checkout", "agent/session");
      yield* f.expectTotals(1, 0, ["task.txt"]);
      run("branch", "integration", "release");
      expect(yield* f.stats({ ...f.worktree, baseBranch: "integration" })).toEqual({
        additions: 1,
        deletions: 0,
        unavailableReason: null,
      });
    }),
);

it.effect(
  "clean upstream merges transform the counterfactual, including subsequent edits to imported files",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("task.txt", "task\n");
      run("checkout", "release");
      commit("upstream.txt", "upstream\nold upstream\n");
      run("checkout", "agent/session");
      run("merge", "--no-ff", "release", "-m", "import upstream");
      yield* f.expectTotals(1, 0, ["task.txt"]);
      commit("upstream.txt", "upstream\n");
      yield* f.expectTotals(1, 1, ["task.txt", "upstream.txt"]);
      // The same graph also safely recovers a legacy record with a preserved creation baseline.
      const { contributionRef: _ref, ...legacy } = f.worktree;
      expect(yield* f.stats(legacy)).toEqual({
        additions: 1,
        deletions: 1,
        unavailableReason: null,
      });
    }),
);

it.effect(
  "exposed synthetic diff baselines remain rooted across later imports and immediate GC",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("task.txt", "task\n");
      run("checkout", "release");
      commit("upstream.txt", "upstream\n");
      run("checkout", "agent/session");
      run("merge", "--no-ff", "release", "-m", "first upstream merge");
      const first = yield* f.expectTotals(1, 0, ["task.txt"]);
      run("checkout", "release");
      commit("later-upstream.txt", "later upstream\n");
      run("checkout", "agent/session");
      run("merge", "--no-ff", "release", "-m", "second upstream merge");
      yield* f.expectTotals(1, 0, ["task.txt"]);
      run("reflog", "expire", "--expire=now", "--all");
      run("gc", "--prune=now");
      expect(run("diff", "--name-only", first.baseRevision ?? "", first.headRevision)).toBe(
        "task.txt",
      );
    }),
);

it.effect("managed clean rebases retain matching net files/counts without importing upstream", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    commit("task.txt", "task\n");
    run("checkout", "release");
    commit("upstream.txt", "upstream\n");
    run("checkout", "agent/session");
    yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
    yield* f.repository.prepareImport("refs/cake/contributions/test", "release");
    run("rebase", "release");
    yield* f.repository.finishImport("refs/cake/contributions/test", "HEAD");
    yield* f.expectTotals(1, 0, ["task.txt"]);
  }),
);

it.effect("a rebase with no local commits imports upstream but contributes zero", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    run("checkout", "release");
    commit("upstream.txt", "upstream\n");
    run("checkout", "agent/session");
    yield* f.repository.prepareImport("refs/cake/contributions/test", "release");
    run("rebase", "release");
    yield* f.repository.finishImport("refs/cake/contributions/test", "HEAD");
    yield* f.expectTotals(0, 0, []);
  }),
);

for (const strategy of ["merge", "squash"] as const)
  it.effect(
    `${strategy} landing retains the contribution and subsequent work accumulates net`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const source = commit("task.txt", "landed\n");
        yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
        run("checkout", "release");
        if (strategy === "merge") run("merge", "--no-ff", "agent/session", "-m", "land task");
        else {
          run("merge", "--squash", "agent/session");
          run("commit", "-m", "land task");
        }
        run("checkout", "agent/session");
        Object.assign(f.worktree, { landedSourceCommit: source, state: "landed" });
        const landed = yield* f.expectTotals(1, 0, ["task.txt"]);
        expect(landed.totalCommits).toBe(0);
        commit("task.txt", "landed\nfresh\n");
        yield* f.expectTotals(2, 0, ["task.txt"]);
        // Replay only post-landing commits onto the target, as Cake does after squash landing.
        yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
        yield* f.repository.prepareImport("refs/cake/contributions/test", "release", source);
        run("rebase", "--onto", "release", source);
        yield* f.repository.finishImport("refs/cake/contributions/test", "HEAD");
        yield* f.expectTotals(2, 0, ["task.txt"]);
      }),
  );

it.effect(
  "recovers provably clean legacy history, not missing baselines or unobserved inline upstream imports",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("task.txt", "task\n");
      const { contributionRef: _ref, ...legacy } = f.worktree;
      expect(yield* f.stats(legacy)).toEqual({
        additions: 1,
        deletions: 0,
        unavailableReason: null,
      });
      expect(yield* f.stats({ ...legacy, baseCommit: undefined })).toMatchObject({
        additions: null,
        deletions: null,
        unavailableReason: expect.stringContaining("creation baseline"),
      });
      run("checkout", "release");
      commit("upstream.txt", "upstream\n");
      run("checkout", "agent/session");
      run("rebase", "release");
      for (const worktree of [legacy, f.worktree])
        expect(yield* f.stats(worktree)).toMatchObject({
          additions: null,
          deletions: null,
          unavailableReason: expect.stringContaining("import boundary"),
        });
      run("update-ref", "-d", "refs/cake/contributions/test");
      expect(yield* f.stats(f.worktree)).toMatchObject({
        additions: null,
        deletions: null,
        unavailableReason: expect.any(String),
      });
    }),
);

it.effect(
  "legacy creation snapshots exclude inherited work even with a behind target, and recover explicit merge landings",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const inherited = commit("inherited.txt", "inherited before this worktree\n");
      const { contributionRef: _ref, ...original } = f.worktree;
      const legacy = { ...original, baseCommit: inherited };
      commit("task.txt", "own work\n");
      expect(yield* f.stats(legacy)).toEqual({
        additions: 1,
        deletions: 0,
        unavailableReason: null,
      });
      run("checkout", "release");
      run("merge", "--no-ff", "agent/session", "-m", "land through an explicit merge");
      run("checkout", "agent/session");
      expect(yield* f.stats(legacy)).toEqual({
        additions: 1,
        deletions: 0,
        unavailableReason: null,
      });
    }),
);

it.effect(
  "an externally missing branch is unavailable, not the old checkpoint masquerading as current contribution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("task.txt", "task\n");
      yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
      run("checkout", "release");
      run("branch", "-D", "agent/session");
      for (const state of ["missing", "resolved"] as const)
        expect(yield* f.stats({ ...f.worktree, state })).toMatchObject({
          additions: null,
          deletions: null,
          unavailableReason: expect.any(String),
        });
    }),
);

it.effect("an externally rewritten observed source cannot silently acquire a new baseline", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    commit("task.txt", "task\n");
    yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
    run("checkout", "release");
    commit("upstream.txt", "upstream\n");
    run("checkout", "agent/session");
    run("rebase", "release");
    expect(yield* f.stats(f.worktree)).toMatchObject({
      additions: null,
      deletions: null,
      unavailableReason: expect.stringContaining("rewritten without a contribution checkpoint"),
    });
  }),
);

it.effect("a recorded clean replay with an unexplained amended tree remains unavailable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    commit("task.txt", "task\n");
    yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
    run("checkout", "release");
    commit("upstream.txt", "upstream\n");
    run("checkout", "agent/session");
    yield* f.repository.prepareImport("refs/cake/contributions/test", "release");
    run("rebase", "release");
    writeFileSync(join(directory, "task.txt"), "unexplained rewrite\n");
    run("add", "task.txt");
    run("commit", "--amend", "--no-edit");
    yield* f.repository.finishImport("refs/cake/contributions/test", "HEAD");
    expect(yield* f.stats(f.worktree)).toMatchObject({
      additions: null,
      deletions: null,
      unavailableReason: expect.stringContaining("does not match the recorded clean rebase"),
    });
  }),
);

it.effect(
  "manual merge-resolution edits are unavailable rather than attributed to the worktree or upstream",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("task.txt", "task\n");
      run("checkout", "release");
      commit("upstream.txt", "upstream\n");
      run("checkout", "agent/session");
      run("merge", "--no-commit", "--no-ff", "release");
      commit("resolution.txt", "extra merge edits\n");
      expect(yield* f.stats(f.worktree)).toMatchObject({
        additions: null,
        deletions: null,
        unavailableReason: expect.stringContaining("additional edits"),
      });
      const data = yield* f.review();
      expect(data.files).toEqual([]);
      expect(data.baseRevision).toBeNull();
    }),
);

it.effect(
  "pending checkpoints survive a crash before replay and recover successful replay plus later commits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("task.txt", "task\n");
      run("checkout", "release");
      commit("upstream.txt", "upstream\n");
      run("checkout", "agent/session");
      yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
      const checkpoint = run("rev-parse", "refs/cake/contributions/test");
      yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
      expect(run("rev-parse", "refs/cake/contributions/test")).toBe(checkpoint);
      yield* f.repository.prepareImport("refs/cake/contributions/test", "release");
      const pending = run("rev-parse", "refs/cake/contributions/test");
      yield* f.repository.prepareImport("refs/cake/contributions/test", "release");
      expect(run("rev-parse", "refs/cake/contributions/test")).toBe(pending);
      yield* f.expectTotals(1, 0, ["task.txt"]); // command never started
      run("rebase", "release");
      commit("later.txt", "later\n"); // crash before finishImport
      yield* f.expectTotals(2, 0, ["task.txt", "later.txt"]);
      yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
      run("reflog", "expire", "--expire=now", "--all");
      run("gc", "--prune=now");
      yield* f.expectTotals(2, 0, ["task.txt", "later.txt"]);
    }),
);

it.effect(
  "conflicted rebase is unavailable while paused and after manual resolution, but abort restores evidence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      commit("file.txt", "local\n");
      run("checkout", "release");
      commit("file.txt", "upstream\n");
      run("checkout", "agent/session");
      yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
      yield* f.repository.prepareImport("refs/cake/contributions/test", "release");
      expect(() => run("rebase", "release")).toThrow();
      expect((yield* f.repository.inspect(f.worktree, "HEAD")).unavailableReason).toContain(
        "in progress",
      );
      expect(yield* f.stats(f.worktree)).toMatchObject({
        additions: null,
        deletions: null,
        unavailableReason: expect.stringContaining("in progress"),
      });
      run("rebase", "--abort");
      yield* f.expectTotals(1, 2, ["file.txt"]);
      expect(() => run("rebase", "release")).toThrow();
      writeFileSync(join(directory, "file.txt"), "resolved\n");
      run("add", "file.txt");
      run("-c", "core.editor=true", "rebase", "--continue");
      yield* f.repository.finishImport("refs/cake/contributions/test", "HEAD");
      expect(yield* f.stats(f.worktree)).toMatchObject({
        additions: null,
        deletions: null,
        unavailableReason: expect.stringContaining("conflict resolution"),
      });
    }),
);

it.effect(
  "metadata persistence failure prevents history mutation while keeping evidence rooted",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const { contributionRef: _ref, ...legacy } = f.worktree;
      commit("task.txt", "task\n");
      const before = run("rev-parse", "HEAD");
      const result = yield* retainContribution(
        legacy,
        () => Effect.fail(new Error("storage unavailable")),
        f.git,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(run("rev-parse", "HEAD")).toBe(before);
      expect(
        run("for-each-ref", "--format=%(refname)", "refs/cake/contributions").split("\n"),
      ).toHaveLength(2);
    }),
);

it.effect("upstream replacements of landed local lines are explicitly ambiguous", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    commit("task.txt", "local\n");
    yield* f.repository.checkpoint(f.worktree, "refs/cake/contributions/test");
    run("checkout", "release");
    run("merge", "--no-ff", "agent/session", "-m", "land task");
    commit("task.txt", "upstream replacement\n");
    run("checkout", "agent/session");
    run("merge", "--no-ff", "release", "-m", "import replacement");
    expect(yield* f.stats(f.worktree)).toMatchObject({
      additions: null,
      deletions: null,
      unavailableReason: expect.stringContaining("overlap"),
    });
  }),
);

it.effect("CAS failures preserve the competing Git root rather than overwrite newer evidence", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const competing = commit("task.txt", "task\n");
    let intercepted = false;
    const racing = makeContributionRepository(
      directory,
      Git.of({
        run: (cwd, args) => {
          if (args[0] === "update-ref" && !intercepted) {
            intercepted = true;
            run("update-ref", "refs/cake/contributions/test", competing);
          }
          return f.git.run(cwd, args);
        },
      }),
    );
    const result = yield* racing
      .checkpoint(f.worktree, "refs/cake/contributions/test")
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(run("rev-parse", "refs/cake/contributions/test")).toBe(competing);
    expect(yield* f.stats(f.worktree)).toMatchObject({
      additions: null,
      deletions: null,
      unavailableReason: expect.any(String),
    });
  }),
);

it.effect("binary files stay in contribution files without fabricated line counts", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    writeFileSync(join(directory, "image.png"), new Uint8Array([1, 0, 2]));
    run("add", ".");
    run("commit", "-m", "binary");
    const data = yield* f.expectTotals(0, 0, ["image.png"]);
    expect(data.files[0]?.additions).toBeNull();
  }),
);
