import { it } from "@effect/vitest";
import { afterEach, beforeEach, expect } from "vitest";
import { Effect, Layer } from "effect";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCommitStatsReader } from "../../../src/domain/worktrees/worktreeCommitStats";
import { Git, GitError } from "../../../src/services/git/Git";

let directory: string;
const run = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cake-commit-stats-"));
  run("init", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.effect(
  "counts only commits since the recorded session base and reports the net committed delta",
  () =>
    Effect.gen(function* () {
      writeFileSync(join(directory, "file.txt"), "base\nold\n");
      run("add", ".");
      run("commit", "-m", "Unrelated base history");
      run("commit", "--allow-empty", "-m", "More unrelated base history");
      const baseCommit = run("rev-parse", "HEAD");
      run("checkout", "-b", "agent/session");
      writeFileSync(join(directory, "file.txt"), "base\nnew\nextra\n");
      run("commit", "-am", "Session edit");
      run("commit", "--allow-empty", "-m", "Session checkpoint");
      // Other branches advancing must not alter the session range.
      run("checkout", "main");
      run("commit", "--allow-empty", "-m", "Unrelated later commit");
      run("checkout", "agent/session");
      // Uncommitted work is not part of these metrics.
      writeFileSync(join(directory, "file.txt"), "uncommitted\n");
      const calls: string[] = [];
      const layer = Layer.succeed(
        Git,
        Git.of({
          run: (cwd, args) =>
            Effect.try({
              try: () => {
                calls.push(args[0] ?? "");
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
      const read = yield* makeCommitStatsReader().pipe(Effect.provide(layer));
      const record = {
        projectPath: directory,
        worktreePath: directory,
        branch: "agent/session",
        baseBranch: "main",
        baseCommit,
        createdAt: "",
      };
      expect(yield* read(record)).toEqual({ commitCount: 2, additions: 2, deletions: 1 });
      expect(yield* read(record)).toEqual({ commitCount: 2, additions: 2, deletions: 1 });
      expect(calls.filter((call) => call === "diff")).toHaveLength(1);
      run("commit", "--allow-empty", "-m", "Another checkpoint");
      expect(yield* read(record)).toEqual({ commitCount: 3, additions: 2, deletions: 1 });
      expect(yield* read({ ...record, baseCommit: run("rev-parse", "HEAD") })).toEqual({
        commitCount: 0,
        additions: 0,
        deletions: 0,
      });
      expect(yield* read({ ...record, baseCommit: undefined })).toBeUndefined();
      expect(yield* read({ ...record, branch: "missing" })).toBeUndefined();
      expect(yield* read({ ...record, projectPath: "/does-not-exist" })).toBeUndefined();
      expect(yield* read({ ...record, baseCommit: "unavailable" })).toBeUndefined();
    }),
);

it.effect(
  "uses the full range count without loading a capped commit log, and ignores binary line counts",
  () =>
    Effect.gen(function* () {
      const commands: ReadonlyArray<string>[] = [];
      const read = yield* makeCommitStatsReader().pipe(
        Effect.provideService(
          Git,
          Git.of({
            run: (_, args) => {
              commands.push(args);
              return Effect.succeed(
                args[0] === "rev-parse"
                  ? "tip\n"
                  : args[0] === "rev-list"
                    ? "250\n"
                    : "120\t35\tcode.ts\0-\t-\timage.png\0",
              );
            },
          }),
        ),
      );
      expect(
        yield* read({
          projectPath: directory,
          worktreePath: directory,
          branch: "agent/session",
          baseBranch: "main",
          baseCommit: "base",
          createdAt: "",
        }),
      ).toEqual({ commitCount: 250, additions: 120, deletions: 35 });
      expect(commands.map((args) => args[0])).toEqual(["rev-parse", "rev-list", "diff"]);
      expect(commands[1]).toContain("base..tip");
    }),
);
