import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { inspect } from "../../../src/domain/worktrees/worktreeChanges";
import { Git, GitError } from "../../../src/services/git/Git";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { parseNumstat } from "../../../src/services/git/git-numstat";
import { changeTotals, commitListLimit } from "../../../src/contracts/worktrees/worktree-changes";
import type { WorktreeStatus } from "../../../src/contracts/worktrees/worktree-contract";

const status: WorktreeStatus = {
  record: {
    projectPath: "/project",
    worktreePath: "/checkout",
    branch: "agent/review",
    baseBranch: "main",
    landedSourceCommit: "acknowledged",
    createdAt: "2026-01-01T00:00:00.000Z",
    state: "landed",
  },
  targetBranch: "main",
  dirtyCount: 2,
  aheadCount: 1,
  behindCount: 0,
  merged: false,
  targetDirty: false,
  targetOnBranch: true,
  merging: false,
  rebasing: false,
  squashMessageReady: false,
};
function dependencies(
  options: {
    allowed?: boolean;
    status?: WorktreeStatus;
    log?: string;
    staged?: string;
    unstaged?: string;
    untracked?: Record<string, Uint8Array>;
    /** Local branches: name, ahead, behind relative to HEAD. */
    branches?: ReadonlyArray<readonly [string, number, number]>;
    total?: number;
    branch?: string;
    reflog?: string;
    fail?: { command: string; message: string };
  } = {},
) {
  const commands: string[][] = [];
  const git = Layer.succeed(
    Git,
    Git.of({
      run: (cwd, args) => {
        commands.push([...args]);
        if (args.includes("--walk-reflogs")) return Effect.succeed(options.reflog ?? "");
        if (options.fail && args[0] === options.fail.command)
          return Effect.fail(
            new GitError({
              operation: `git ${args.join(" ")}`,
              workingDirectory: cwd,
              message: options.fail.message,
            }),
          );
        if (args[0] === "rev-parse")
          return Effect.succeed(
            args.includes("--abbrev-ref") ? `${options.branch ?? "agent/review"}\n` : "tip\n",
          );
        if (args[0] === "merge-base")
          return Effect.succeed(
            args.includes("acknowledged") && args.includes("tip") ? "acknowledged\n" : "fork\n",
          );
        if (args[0] === "for-each-ref")
          return Effect.succeed(
            (options.branches ?? [["main", 0, 1]])
              .map(
                ([branch, ahead, behind]) =>
                  `refs/heads/${branch}\0${branch}\0\0${ahead} ${behind}\n`,
              )
              .join(""),
          );
        if (args[0] === "rev-list") return Effect.succeed(`${options.total ?? 1}\n`);
        if (args[0] === "log") return Effect.succeed(options.log ?? "");
        if (args[0] === "diff")
          return Effect.succeed(
            args.includes("--cached") ? (options.staged ?? "") : (options.unstaged ?? ""),
          );
        if (args[0] === "ls-files")
          return Effect.succeed(
            Object.keys(options.untracked ?? {})
              .map((path) => `${path}\0`)
              .join(""),
          );
        return Effect.die(`Unexpected Git arguments: ${args.join(" ")}`);
      },
    }),
  );
  const layer = Layer.mergeAll(
    git,
    Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(options.allowed ?? true) }),
    Layer.mock(ManagedWorktrees, { status: () => Effect.succeed(options.status) }),
    Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (path) =>
          Effect.succeed(!path.endsWith("old name.ts") && !path.endsWith("file\tname.ts")),
        readFile: (path) =>
          Effect.succeed(options.untracked?.[path.replace("/checkout/", "")] ?? new Uint8Array()),
      }),
    ),
  );
  return { layer, commands };
}

const commitLog = (commands: string[][]) =>
  commands.find((args) => args[0] === "log" && !args.includes("--walk-reflogs"));

describe("Worktree Changes Git projection", () => {
  it.effect(
    "uses the managed landing checkpoint rather than an inferred parent and preserves historical deltas",
    () =>
      Effect.gen(function* () {
        const fixture = dependencies({
          status,
          log: [
            "\x1eabc123",
            "Review pane",
            "",
            "\n:100644 000000 123 000 D",
            "old name.ts",
            "6\t2\tfile\tname.ts",
            "0\t8\told name.ts",
            "-\t-\timage.png",
            "",
          ].join("\0"),
          staged: "10\t2\tREADME.md\0",
          unstaged: "7\t1\tsrc/pane.tsx\0",
          untracked: {
            "new.ts": new TextEncoder().encode("one\ntwo"),
            "new.png": new Uint8Array([1, 0, 2]),
          },
        });
        const result = yield* inspect("/checkout", {}).pipe(Effect.provide(fixture.layer));
        expect(commitLog(fixture.commands)).toEqual(
          expect.arrayContaining(["tip", "^acknowledged"]),
        );
        expect(result.commits).toHaveLength(1);
        expect(result.commits[0]?.files).toEqual([
          {
            path: "file\tname.ts",
            deleted: false,
            workingTreeExists: false,
            additions: 6,
            deletions: 2,
          },
          {
            path: "old name.ts",
            deleted: true,
            workingTreeExists: false,
            additions: 0,
            deletions: 8,
          },
          {
            path: "image.png",
            deleted: false,
            workingTreeExists: true,
            additions: null,
            deletions: null,
          },
        ]);
        expect(changeTotals(result.commits[0]?.files ?? [])).toEqual({
          additions: 6,
          deletions: 10,
          binary: 1,
        });
        expect(result.staged[0]).toMatchObject({ additions: 10, deletions: 2 });
        expect(result.unstaged).toEqual([
          {
            path: "src/pane.tsx",
            deleted: false,
            workingTreeExists: true,
            additions: 7,
            deletions: 1,
          },
          { path: "new.ts", deleted: false, workingTreeExists: true, additions: 2, deletions: 0 },
          {
            path: "new.png",
            deleted: false,
            workingTreeExists: true,
            additions: null,
            deletions: null,
          },
        ]);
      }),
  );

  it.effect("reviews only the working tree when no other branch is a possible parent", () =>
    Effect.gen(function* () {
      // agent/child contains HEAD (behind 0): a child of this branch, never its parent.
      const fixture = dependencies({ branches: [["agent/child", 2, 0]] });
      const result = yield* inspect("/checkout", {}).pipe(Effect.provide(fixture.layer));
      expect(result).toEqual({
        branch: "agent/review",
        base: null,
        baseAlternatives: [],
        baseRevision: null,
        headRevision: "tip",
        contributionUnavailableReason: "This checkout has no recorded worktree creation baseline",
        files: [],
        commits: [],
        totalCommits: 0,
        staged: [],
        unstaged: [],
      });
      expect(commitLog(fixture.commands)).toBeUndefined();
    }),
  );

  it.effect("skips a nearer branch created after this one: it is a child that diverged", () =>
    Effect.gen(function* () {
      const fixture = dependencies({
        branches: [
          ["agent/child", 1, 1],
          ["main", 0, 3],
        ],
        reflog: [
          "refs/heads/agent/child@{300}",
          "refs/heads/agent/child@{200}",
          "refs/heads/agent/review@{100}",
        ].join("\n"),
      });
      const result = yield* inspect("/checkout", {}).pipe(Effect.provide(fixture.layer));
      expect(result.base).toBe("main");
      expect(result.baseAlternatives).toEqual([{ branch: "main", distance: 3 }]);
    }),
  );

  it.effect("compares a brand-new child with its parent and lists no commits", () =>
    Effect.gen(function* () {
      // The parent contains HEAD (behind 0) and Git recorded it before this branch.
      const fixture = dependencies({
        branches: [
          ["agent/parent", 0, 0],
          ["main", 0, 2],
        ],
        total: 0,
        reflog: ["refs/heads/agent/review@{200}", "refs/heads/agent/parent@{100}"].join("\n"),
      });
      const result = yield* inspect("/checkout", {}).pipe(Effect.provide(fixture.layer));
      expect(result.base).toBe("agent/parent");
      expect(result.totalCommits).toBe(0);
      expect(result.commits).toEqual([]);
    }),
  );

  it.effect("never infers a parent for the trunk itself", () =>
    Effect.gen(function* () {
      const fixture = dependencies({ branch: "main", branches: [["agent/old", 0, 4]] });
      const result = yield* inspect("/checkout", {}).pipe(Effect.provide(fixture.layer));
      expect(result.base).toBeNull();
      expect(fixture.commands.some((args) => args[0] === "for-each-ref")).toBe(false);
    }),
  );

  it.effect("caps the listed commits and reports the full range size", () =>
    Effect.gen(function* () {
      const fixture = dependencies({
        branches: [["main", 0, 8156]],
        total: 8156,
        log: "\x1eabc\0Latest\0\0",
      });
      const result = yield* inspect("/checkout", {}).pipe(Effect.provide(fixture.layer));
      expect(commitLog(fixture.commands)).toContain(`--max-count=${commitListLimit}`);
      expect(fixture.commands.find((args) => args[0] === "rev-list")).toEqual([
        "rev-list",
        "--count",
        "tip",
        "^tip",
        "^fork",
        "--",
      ]);
      expect(result.totalCommits).toBe(8156);
    }),
  );

  it.effect("names the failing Git command instead of hiding the error", () =>
    Effect.gen(function* () {
      const fixture = dependencies({
        fail: { command: "log", message: "stdout maxBuffer length exceeded" },
      });
      const error = yield* inspect("/checkout", {}).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
      );
      expect(error.message).toBe("git log failed: stdout maxBuffer length exceeded");
    }),
  );

  it.effect("explains when Git is too old to compare branches in one pass", () =>
    Effect.gen(function* () {
      const fixture = dependencies({
        fail: { command: "for-each-ref", message: "fatal: unknown field name: ahead-behind:HEAD" },
      });
      const error = yield* inspect("/checkout", {}).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
      );
      expect(error.message).toBe(
        "git for-each-ref failed: Finding the parent branch requires Git 2.41 or newer",
      );
    }),
  );

  it.effect("refuses paths outside existing project access before invoking Git", () =>
    Effect.gen(function* () {
      const fixture = dependencies({ allowed: false });
      const result = yield* inspect("/checkout", {}).pipe(
        Effect.provide(fixture.layer),
        Effect.flip,
      );
      expect(result.message).toContain("not selected");
      expect(fixture.commands).toEqual([]);
    }),
  );

  it("retains whitespace paths and binary values from Git's NUL-separated records", () => {
    expect(parseNumstat("1\t0\t leading space \0-\t-\timage.png\0")).toEqual([
      { path: " leading space ", deleted: false, additions: 1, deletions: 0 },
      { path: "image.png", deleted: false, additions: null, deletions: null },
    ]);
  });
});
