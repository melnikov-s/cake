import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Ref } from "effect";
import { describe, expect } from "vitest";
import type { WorktreeRecord } from "../../../../src/domain/worktrees/managed-worktree-data";
import { BootstrapLive } from "../../../../src/main/BootstrapLive";
import { Git, GitError } from "../../../../src/services/git/Git";
import { WorktreeStorage } from "../../../../src/services/storage/WorktreeStorage";
import { ManagedWorktrees } from "../../../../src/services/worktrees/ManagedWorktrees";
import { ManagedWorktreesLive } from "../../../../src/services/worktrees/ManagedWorktreesLive";

const record = (projectPath: string, worktreePath: string, branch: string): WorktreeRecord => ({
  projectPath,
  worktreePath,
  branch,
  baseBranch: "main",
  createdAt: new Date(0).toISOString(),
  state: "active",
});

const makeLayer = (initial: ReadonlyArray<WorktreeRecord>) => {
  const storage = Layer.effect(
    WorktreeStorage,
    Effect.gen(function* () {
      const records = yield* Ref.make(initial);
      return WorktreeStorage.of({
        load: () => Ref.get(records),
        save: (next) => Ref.set(records, next),
      });
    }),
  );
  const git = Layer.succeed(
    Git,
    Git.of({
      run: (_workingDirectory, arguments_) => {
        const [command, ...args] = arguments_;
        if (command === "status") return Effect.succeed("");
        if (command === "rev-list") return Effect.succeed("1\n");
        if (command === "merge-base")
          return Effect.fail(
            new GitError({ operation: "merge-base", workingDirectory: "", message: "no" }),
          );
        if (command === "rev-parse" && args[0] === "--abbrev-ref") return Effect.succeed("main\n");
        if (command === "rev-parse" && args[0] === "--git-path") return Effect.succeed("\n");
        if (command === "rev-parse" && args[0] === "--verify")
          return Effect.fail(
            new GitError({ operation: "rev-parse", workingDirectory: "", message: "no" }),
          );
        if (command === "rev-parse") return Effect.succeed("head\n");
        return Effect.succeed("");
      },
    }),
  );
  return Layer.mergeAll(storage, git, BootstrapLive);
};

describe("ManagedWorktrees Effect service", () => {
  it.effect(
    "keeps exact FIFO reservations per repository while repositories remain independent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repositoryA = `${temporary}/repo-a`;
          const repositoryB = `${temporary}/repo-b`;
          const firstPath = `${temporary}/first`;
          const secondPath = `${temporary}/second`;
          const thirdPath = `${temporary}/third`;
          const independentPath = `${temporary}/independent`;
          for (const directory of [
            repositoryA,
            repositoryB,
            firstPath,
            secondPath,
            thirdPath,
            independentPath,
          ])
            yield* fileSystem.makeDirectory(directory, { recursive: true });

          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([
                record(repositoryA, firstPath, "agent/first"),
                record(repositoryA, secondPath, "agent/second"),
                record(repositoryA, thirdPath, "agent/third"),
                record(repositoryB, independentPath, "agent/independent"),
              ]),
            ),
          );

          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            yield* worktrees.prepareLanding(firstPath, "first");
            const second = yield* worktrees
              .prepareLanding(secondPath, "second")
              .pipe(Effect.forkScoped);
            const third = yield* worktrees
              .prepareLanding(thirdPath, "third")
              .pipe(Effect.forkScoped);

            expect(yield* worktrees.status(secondPath)).toMatchObject({
              landingState: "queued",
              landingQueuePosition: 1,
            });
            expect(yield* worktrees.status(thirdPath)).toMatchObject({
              landingState: "queued",
              landingQueuePosition: 2,
            });

            // A different repository acquires immediately despite repository A's queue.
            yield* worktrees.prepareLanding(independentPath, "independent");
            expect(yield* worktrees.status(independentPath)).toMatchObject({
              landingState: "running",
            });

            yield* worktrees.cancelLanding(firstPath, "first");
            yield* Fiber.join(second);
            expect(yield* worktrees.status(secondPath)).toMatchObject({
              landingState: "running",
            });
            expect(yield* worktrees.status(thirdPath)).toMatchObject({
              landingState: "queued",
              landingQueuePosition: 1,
            });

            yield* worktrees.cancelLanding(secondPath, "second");
            yield* Fiber.join(third);
            expect(yield* worktrees.status(thirdPath)).toMatchObject({
              landingState: "running",
            });
            yield* worktrees.cancelLanding(thirdPath, "third");
            yield* worktrees.cancelLanding(independentPath, "independent");
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(BootstrapLive)),
      ),
  );
});
