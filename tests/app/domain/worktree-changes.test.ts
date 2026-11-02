import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { inspect } from "../../../src/domain/worktrees/worktreeChanges";
import { Git, GitError } from "../../../src/services/git/Git";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { parseNumstat } from "../../../src/services/git/git-numstat";
import { changeTotals } from "../../../src/contracts/worktrees/worktree-changes";
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
    upstream?: string;
  } = {},
) {
  const commands: string[][] = [];
  const git = Layer.succeed(
    Git,
    Git.of({
      run: (cwd, args) => {
        commands.push([...args]);
        if (args[0] === "rev-parse") {
          if (args.includes("@{upstream}") && !options.upstream)
            return Effect.fail(
              new GitError({ operation: "run", workingDirectory: cwd, message: "No upstream" }),
            );
          return Effect.succeed(
            args.includes("@{upstream}") ? (options.upstream ?? "") : "agent/review\n",
          );
        }
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

describe("Worktree Changes Git projection", () => {
  it.effect("uses landing's target/checkpoint range and preserves every file's deltas", () =>
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
      const result = yield* inspect("/checkout").pipe(Effect.provide(fixture.layer));
      expect(fixture.commands.find((args) => args[0] === "log")).toEqual(
        expect.arrayContaining(["HEAD", "^acknowledged", "^main"]),
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

  it.effect(
    "returns clean/no-commit state without counting repository history when no baseline exists",
    () =>
      Effect.gen(function* () {
        const fixture = dependencies();
        const result = yield* inspect("/checkout").pipe(Effect.provide(fixture.layer));
        expect(result).toEqual({
          branch: "agent/review",
          base: "HEAD",
          commits: [],
          staged: [],
          unstaged: [],
        });
        expect(fixture.commands.find((args) => args[0] === "log")).toContain("HEAD..HEAD");
      }),
  );

  it.effect("uses the configured upstream for ordinary non-managed checkouts", () =>
    Effect.gen(function* () {
      const fixture = dependencies({ upstream: "origin/feature\n" });
      const result = yield* inspect("/checkout").pipe(Effect.provide(fixture.layer));
      expect(result.base).toBe("origin/feature");
      expect(fixture.commands.find((args) => args[0] === "log")).toContain("origin/feature..HEAD");
    }),
  );

  it.effect("refuses paths outside existing project access before invoking Git", () =>
    Effect.gen(function* () {
      const fixture = dependencies({ allowed: false });
      const result = yield* inspect("/checkout").pipe(Effect.provide(fixture.layer), Effect.flip);
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
