import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Ref } from "effect";
import { describe, expect } from "vitest";
import { defaultProjectSettings } from "../../../../src/domain/application/application-data";
import type { WorktreeRecord } from "../../../../src/domain/worktrees/managed-worktree-data";
import { BootstrapLive } from "../../../../src/main/BootstrapLive";
import { Git, GitError } from "../../../../src/services/git/Git";
import {
  WorktreeStorage,
  WorktreeStorageError,
} from "../../../../src/services/storage/WorktreeStorage";
import { ManagedWorktrees } from "../../../../src/services/worktrees/ManagedWorktrees";
import { ManagedWorktreesLive } from "../../../../src/services/worktrees/ManagedWorktreesLive";
import { ChildProcessSpawner } from "effect/unstable/process";

const record = (projectPath: string, worktreePath: string, branch: string): WorktreeRecord => ({
  projectPath,
  worktreePath,
  branch,
  baseBranch: "main",
  createdAt: new Date(0).toISOString(),
  state: "active",
});

const makeLayer = (
  initial: ReadonlyArray<WorktreeRecord>,
  options?: {
    readonly commonDirectory?: (workingDirectory: string) => string;
    readonly save?: (
      records: ReadonlyArray<WorktreeRecord>,
    ) => Effect.Effect<void, WorktreeStorageError>;
    readonly run?: (
      workingDirectory: string,
      arguments_: ReadonlyArray<string>,
    ) => Effect.Effect<string, GitError> | undefined;
    readonly onRun?: (
      workingDirectory: string,
      arguments_: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    readonly runSetup?: Effect.Effect<string>;
  },
) => {
  const storage = Layer.effect(
    WorktreeStorage,
    Effect.gen(function* () {
      const records = yield* Ref.make(initial);
      return WorktreeStorage.of({
        load: () => Ref.get(records),
        save: options?.save ?? ((next) => Ref.set(records, next)),
      });
    }),
  );
  const git = Layer.succeed(
    Git,
    Git.of({
      run: (workingDirectory, arguments_) => {
        const respond = <A, E>(effect: Effect.Effect<A, E>) =>
          (options?.onRun?.(workingDirectory, arguments_) ?? Effect.void).pipe(
            Effect.andThen(effect),
          );
        const overridden = options?.run?.(workingDirectory, arguments_);
        if (overridden) return respond(overridden);
        const [command, ...args] = arguments_;
        if (
          command === "rev-parse" &&
          args[0] === "--path-format=absolute" &&
          args[1] === "--git-common-dir"
        )
          return respond(
            Effect.succeed(
              `${options?.commonDirectory?.(workingDirectory) ?? workingDirectory}/.git\n`,
            ),
          );
        if (command === "status") return respond(Effect.succeed(""));
        if (command === "rev-list") return respond(Effect.succeed("1\n"));
        if (command === "merge-base")
          return respond(
            Effect.fail(
              new GitError({ operation: "merge-base", workingDirectory: "", message: "no" }),
            ),
          );
        if (command === "rev-parse" && args[0] === "--abbrev-ref")
          return respond(Effect.succeed("main\n"));
        if (command === "rev-parse" && args[0] === "--git-path")
          return respond(Effect.succeed("\n"));
        if (command === "rev-parse" && args[0] === "--verify")
          return respond(
            Effect.fail(
              new GitError({ operation: "rev-parse", workingDirectory: "", message: "no" }),
            ),
          );
        if (command === "rev-parse") return respond(Effect.succeed("head\n"));
        return respond(Effect.succeed(""));
      },
    }),
  );
  const platform = options?.runSetup
    ? Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
          string: () => options.runSetup ?? Effect.succeed(""),
        }),
      )
    : BootstrapLive;
  return Layer.mergeAll(storage, git, platform);
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
            `${repositoryA}/.git`,
            `${repositoryB}/.git`,
            firstPath,
            secondPath,
            thirdPath,
            independentPath,
          ])
            yield* fileSystem.makeDirectory(directory, { recursive: true });

          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer(
                [
                  record(repositoryA, firstPath, "agent/first"),
                  record(repositoryA, secondPath, "agent/second"),
                  record(repositoryA, thirdPath, "agent/third"),
                  record(repositoryB, independentPath, "agent/independent"),
                ],
                {
                  commonDirectory: (workingDirectory) =>
                    workingDirectory === independentPath || workingDirectory === repositoryB
                      ? repositoryB
                      : repositoryA,
                },
              ),
            ),
          );

          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            yield* worktrees.prepareLanding(firstPath, "first");
            const second = yield* worktrees
              .prepareLanding(secondPath, "second")
              .pipe(Effect.forkScoped);

            const awaitQueued = Effect.fn("Test.awaitQueued")(function* (
              worktreePath: string,
              position: number,
            ) {
              while (true) {
                const status = yield* worktrees.status(worktreePath);
                if (status?.landingState === "queued") {
                  expect(status.landingQueuePosition).toBe(position);
                  return;
                }
                yield* Effect.yieldNow;
              }
            });
            yield* awaitQueued(secondPath, 1);
            const third = yield* worktrees
              .prepareLanding(thirdPath, "third")
              .pipe(Effect.forkScoped);
            yield* awaitQueued(thirdPath, 2);

            // Interrupting a pending reservation removes it rather than leaving a FIFO ghost.
            yield* Fiber.interrupt(second);
            expect(yield* worktrees.status(thirdPath)).toMatchObject({
              landingState: "queued",
              landingQueuePosition: 1,
            });

            // A different repository acquires immediately despite repository A's queue.
            yield* worktrees.prepareLanding(independentPath, "independent");
            expect(yield* worktrees.status(independentPath)).toMatchObject({
              landingState: "running",
            });

            yield* worktrees.cancelLanding(firstPath, "first");
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

  it.effect("shares landing queues across subdirectory and symlink project paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        const alias = `${temporary}/repo-alias`;
        const nested = `${repository}/nested`;
        const firstPath = `${temporary}/first`;
        const secondPath = `${temporary}/second`;
        for (const directory of [`${repository}/.git`, nested, firstPath, secondPath])
          yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.symlink(repository, alias);

        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer(
              [record(nested, firstPath, "agent/first"), record(alias, secondPath, "agent/second")],
              {
                commonDirectory: (workingDirectory) =>
                  workingDirectory === alias ? alias : repository,
              },
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          yield* worktrees.prepareLanding(firstPath, "first");
          const second = yield* worktrees
            .prepareLanding(secondPath, "second")
            .pipe(Effect.forkScoped);

          while (true) {
            const status = yield* worktrees.status(secondPath);
            if (status?.landingState === "queued") {
              expect(status.landingQueuePosition).toBe(1);
              break;
            }
            yield* Effect.yieldNow;
          }

          yield* worktrees.cancelLanding(firstPath, "first");
          yield* Fiber.join(second);
          expect(yield* worktrees.status(secondPath)).toMatchObject({ landingState: "running" });
          yield* worktrees.cancelLanding(secondPath, "second");
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("returns a background-created record before setup completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
        const setupStarted = yield* Deferred.make<void>();
        const finishSetup = yield* Deferred.make<void>();
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer([], {
              commonDirectory: () => repository,
              run: (_cwd, arguments_) =>
                arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel"
                  ? Effect.succeed(`${repository}\n`)
                  : undefined,
              runSetup: Deferred.succeed(setupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishSetup)),
                Effect.as(""),
              ),
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          const settings = {
            ...defaultProjectSettings(),
            worktreeCreateCommand: "",
            worktreeSetupCommands: "setup",
          };
          const created = yield* worktrees.createWithBackgroundSetup(
            repository,
            undefined,
            "background",
            settings,
          );
          yield* Deferred.await(setupStarted);
          expect(yield* worktrees.hasDeferredSetup(created.worktreePath)).toBe(true);

          const awaiting = yield* worktrees
            .awaitSetup(created.worktreePath)
            .pipe(Effect.forkScoped);
          yield* Deferred.succeed(finishSetup, undefined);
          yield* Fiber.join(awaiting);
          expect(yield* worktrees.hasDeferredSetup(created.worktreePath)).toBe(false);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("keeps an existing record unchanged when update persistence fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        const worktreePath = `${temporary}/worktree`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
        yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
        const initial = record(repository, worktreePath, "agent/existing");
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer([initial], {
              commonDirectory: () => repository,
              save: () =>
                Effect.fail(
                  new WorktreeStorageError({
                    operation: "WorktreeStorage.save",
                    message: "disk full",
                  }),
                ),
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          const result = yield* Effect.result(worktrees.setResolveAfterLanding(worktreePath, true));
          expect(result._tag).toBe("Failure");
          expect(yield* worktrees.records()).toEqual([initial]);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("rolls back checkout and branch when creation persistence fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
        const calls: Array<{
          readonly cwd: string;
          readonly arguments_: ReadonlyArray<string>;
        }> = [];
        const saveError = new WorktreeStorageError({
          operation: "WorktreeStorage.save",
          message: "disk full",
        });
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer([], {
              commonDirectory: () => repository,
              save: () => Effect.fail(saveError),
              run: (cwd, arguments_) => {
                calls.push({ cwd, arguments_ });
                if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel")
                  return Effect.succeed(`${repository}\n`);
                return undefined;
              },
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          const result = yield* Effect.result(
            worktrees.create(repository, undefined, "rollback", undefined),
          );
          expect(result._tag).toBe("Failure");
          expect(yield* worktrees.records()).toEqual([]);
          const add = calls.find(
            (call) => call.arguments_[0] === "worktree" && call.arguments_[1] === "add",
          );
          expect(add).toBeDefined();
          const worktreePath = add?.arguments_[4];
          expect(calls).toContainEqual({
            cwd: add?.cwd,
            arguments_: ["worktree", "remove", "--force", worktreePath],
          });
          expect(
            calls.some((call) => call.arguments_[0] === "branch" && call.arguments_[1] === "-D"),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("rolls back a persisted creation when interrupted during save", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
        const saveStarted = yield* Deferred.make<void>();
        const finishSave = yield* Deferred.make<void>();
        const saveCount = yield* Ref.make(0);
        const calls: Array<ReadonlyArray<string>> = [];
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer([], {
              commonDirectory: () => repository,
              save: () =>
                Ref.updateAndGet(saveCount, (count) => count + 1).pipe(
                  Effect.flatMap((count) =>
                    count === 1
                      ? Deferred.succeed(saveStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(finishSave)),
                        )
                      : Effect.void,
                  ),
                ),
              run: (_cwd, arguments_) => {
                calls.push(arguments_);
                if (arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel")
                  return Effect.succeed(`${repository}\n`);
                return undefined;
              },
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          const creation = yield* worktrees
            .create(repository, undefined, "interrupted", undefined)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(saveStarted);
          const interruption = yield* Fiber.interrupt(creation).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(finishSave, undefined);
          yield* Fiber.join(interruption);

          expect(yield* worktrees.records()).toEqual([]);
          expect(yield* Ref.get(saveCount)).toBe(2);
          expect(
            calls.some((arguments_) => arguments_[0] === "worktree" && arguments_[1] === "remove"),
          ).toBe(true);
          expect(
            calls.some((arguments_) => arguments_[0] === "branch" && arguments_[1] === "-D"),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );
});
