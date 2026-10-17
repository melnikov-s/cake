import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Queue,
  Ref,
  Stream,
} from "effect";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect } from "vitest";
import { defaultProjectSettings } from "../../../../src/contracts/application/application-data";
import type {
  ManagedWorktreeCatalogUpdate,
  WorktreeRecord,
} from "../../../../src/contracts/worktrees/managed-worktree-data";
import { WorktreeStatusIcon } from "../../../../src/renderer/components/worktree-status-icon";
import { WorktreeCatalog } from "../../../../src/renderer/models/WorktreeCatalog";
import { applyManagedWorktreeCatalogUpdate } from "../../../../src/renderer/reducers/WorktreeCatalogReducer";
import { BootstrapLive } from "../../../../src/main/BootstrapLive";
import { Git, GitError, type GitRunner } from "../../../../src/services/git/Git";
import { makeGitLive } from "../../../../src/services/git/GitLive";
import {
  WorktreeStorage,
  WorktreeStorageError,
} from "../../../../src/services/storage/WorktreeStorage";
import { ManagedWorktrees } from "../../../../src/services/worktrees/ManagedWorktrees";
import { ManagedWorktreesLive } from "../../../../src/services/worktrees/ManagedWorktreesLive";
import { createCheckout } from "../../../../src/domain/worktrees/worktreeCreation";
import { ChildProcessSpawner } from "effect/unstable/process";

const record = (projectPath: string, worktreePath: string, branch: string): WorktreeRecord => ({
  projectPath,
  worktreePath,
  branch,
  baseBranch: "main",
  createdAt: new Date(0).toISOString(),
  state: "active",
});

const makeStorageLayer = (initial: ReadonlyArray<WorktreeRecord>) =>
  Layer.effect(
    WorktreeStorage,
    Effect.gen(function* () {
      const records = yield* Ref.make(initial);
      return WorktreeStorage.of({
        load: () => Ref.get(records),
        save: (next) => Ref.set(records, next),
      });
    }),
  );

const makeLiveLayer = (initial: ReadonlyArray<WorktreeRecord>, runner: GitRunner) =>
  Layer.mergeAll(makeStorageLayer(initial), makeGitLive(runner), BootstrapLive);

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
    readonly runSetup?: Effect.Effect<string, PlatformError.PlatformError>;
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
          return respond(
            Effect.succeed(
              `${initial.find((entry) => entry.worktreePath === workingDirectory)?.branch ?? "main"}\n`,
            ),
          );
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
  it.effect.each([
    "origin-default",
    "current-fallback",
    "detached-fallback",
    "explicit-root",
    "active-parent",
    "landed-parent",
    "resolved-parent",
    "discarded-parent",
    "foreign-parent",
    "missing-parent",
    "detached-explicit",
  ] as const)("preserves domain base selection and ownership: %s", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        const parentPath = `${temporary}/parent`;
        yield* fs.makeDirectory(`${repository}/.git`, { recursive: true });
        if (scenario !== "missing-parent") yield* fs.makeDirectory(parentPath);
        const isParent = scenario.endsWith("parent");
        const state =
          scenario === "landed-parent"
            ? "landed"
            : scenario === "resolved-parent"
              ? "resolved"
              : scenario === "discarded-parent"
                ? "discarded"
                : "active";
        const initial = isParent
          ? [
              {
                ...record(
                  scenario === "foreign-parent" ? `${temporary}/other` : repository,
                  parentPath,
                  "agent/parent",
                ),
                state,
              } satisfies WorktreeRecord,
            ]
          : [];
        const detached = scenario.startsWith("detached");
        const calls: Array<ReadonlyArray<string>> = [];
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer(initial, {
              commonDirectory: () => repository,
              run: (_cwd, args) => {
                calls.push(args);
                if (args[0] === "symbolic-ref")
                  return scenario === "origin-default"
                    ? Effect.succeed("origin/trunk\n")
                    : Effect.fail(
                        new GitError({
                          operation: "symbolic-ref",
                          workingDirectory: repository,
                          message: "no remote",
                        }),
                      );
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
                  return Effect.succeed(repository);
                if (args[0] === "rev-parse" && args[1] === "--abbrev-ref")
                  return Effect.succeed(detached ? "HEAD" : "topic");
                if (args[0] === "rev-parse" && !args[1]?.startsWith("--"))
                  return Effect.succeed(`commit:${args[1]}`);
                return undefined;
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          const base = isParent
            ? `${parentPath}/`
            : scenario === "explicit-root" || scenario === "detached-explicit"
              ? `${repository}/`
              : undefined;
          const result = yield* Effect.result(createCheckout(repository, base, "base-rules"));
          const rejected = [
            "resolved-parent",
            "discarded-parent",
            "foreign-parent",
            "missing-parent",
            "detached-explicit",
          ].includes(scenario);
          if (rejected) {
            expect(result).toMatchObject({ _tag: "Failure" });
            expect(yield* worktrees.records()).toEqual(initial);
            expect(calls.some((args) => args[0] === "worktree")).toBe(false);
          } else {
            const expectedBranch = isParent
              ? "agent/parent"
              : scenario === "origin-default"
                ? "trunk"
                : detached
                  ? "main"
                  : "topic";
            const expectedRef = isParent || scenario === "explicit-root" ? "HEAD" : expectedBranch;
            expect(result).toMatchObject({
              _tag: "Success",
              success: {
                projectPath: repository,
                baseBranch: expectedBranch,
                baseCommit: `commit:${expectedRef}`,
                ...(isParent ? { parentWorktreePath: parentPath } : {}),
              },
            });
          }
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect.each([
    undefined,
    "focused-fix",
    "a".repeat(56) + "-------",
    "Upper",
    "",
    "bad_name",
    "a".repeat(64),
  ])("preserves default, truncated and invalid naming rules: %s", (requestedName) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped();
        const repository = `${temporary}/Example Repo`;
        yield* fs.makeDirectory(`${repository}/.git`, { recursive: true });
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer([], {
              run: (_cwd, args) =>
                args[0] === "rev-parse" && args[1] === "--show-toplevel"
                  ? Effect.succeed(repository)
                  : undefined,
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const result = yield* Effect.result(createCheckout(repository, undefined, requestedName));
          const valid =
            requestedName === undefined ||
            requestedName === "focused-fix" ||
            requestedName.length === 63;
          if (valid) {
            expect(result._tag).toBe("Success");
            if (result._tag !== "Success") return;
            const prefix =
              requestedName === undefined
                ? "example-repo"
                : requestedName.slice(0, 56).replace(/-+$/, "");
            expect(result.success.branch).toMatch(new RegExp(`^agent/${prefix}-[a-f0-9]{6}$`));
            expect(result.success.worktreePath).toBe(
              `${yield* fs.realPath(temporary)}/.example-repo-worktrees/${result.success.branch.slice(6)}`,
            );
          } else
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { message: "Invalid worktree name" },
            });
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("retries branch and directory collisions before materializing the chosen name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        yield* fs.makeDirectory(`${repository}/.git`, { recursive: true });
        const rejected: string[] = [];
        let probes = 0;
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer([], {
              run: (_cwd, args) => {
                if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
                  return Effect.succeed(repository);
                if (args[0] !== "rev-parse" || !args[3]?.startsWith("refs/heads/agent/"))
                  return undefined;
                probes += 1;
                if (probes > 2) return undefined;
                const name = args[3].replace("refs/heads/agent/", "");
                rejected.push(`agent/${name}`);
                return probes === 1
                  ? Effect.succeed("existing-branch")
                  : fs
                      .makeDirectory(`${temporary}/.repo-worktrees/${name}`, { recursive: true })
                      .pipe(
                        Effect.orDie,
                        Effect.andThen(
                          Effect.fail(
                            new GitError({
                              operation: "rev-parse",
                              workingDirectory: repository,
                              message: "no branch",
                            }),
                          ),
                        ),
                      );
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const created = yield* createCheckout(repository, undefined, "collision");
          expect(probes).toBe(3);
          expect(rejected).not.toContain(created.branch);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect(
    "serializes creation planning, synchronous setup and cleanup in the same repository",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const temporary = yield* fs.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const existingPath = `${temporary}/existing`;
          yield* fs.makeDirectory(`${repository}/.git`, { recursive: true });
          yield* fs.makeDirectory(existingPath);
          const setupStarted = yield* Deferred.make<void>();
          const finishSetup = yield* Deferred.make<void>();
          const secondDiscovered = yield* Deferred.make<void>();
          let discoveries = 0;
          const mutations: string[] = [];
          let probes = 0;
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([record(repository, existingPath, "agent/existing")], {
                commonDirectory: () => repository,
                runSetup: Deferred.succeed(setupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(finishSetup)),
                  Effect.as(""),
                ),
                run: (_cwd, args) => {
                  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                    discoveries += 1;
                    return discoveries === 1
                      ? Effect.succeed(repository)
                      : Deferred.succeed(secondDiscovered, undefined).pipe(Effect.as(repository));
                  }
                  if (args[0] === "rev-parse" && args[3]?.startsWith("refs/heads/agent/"))
                    probes += 1;
                  if (args[0] === "worktree") mutations.push(args[1] ?? "");
                  return undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            const first = yield* createCheckout(repository, undefined, "first", {
              ...defaultProjectSettings(),
              worktreeCreateCommand: "",
              worktreeSetupCommands: "setup",
            }).pipe(Effect.forkScoped);
            yield* Deferred.await(setupStarted);
            const cleanup = yield* worktrees.discard(existingPath, false).pipe(Effect.forkScoped);
            const second = yield* createCheckout(repository, undefined, "second").pipe(
              Effect.forkScoped,
            );
            yield* Deferred.await(secondDiscovered);
            expect(probes).toBe(1);
            expect(mutations).toEqual(["add"]);
            expect(cleanup.pollUnsafe()).toBeUndefined();
            expect(second.pollUnsafe()).toBeUndefined();
            yield* Deferred.succeed(finishSetup, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(cleanup);
            yield* Fiber.join(second);
            expect(probes).toBe(3); // Both creations plus the discarded branch existence check.
            expect(mutations.filter((operation) => operation === "add")).toHaveLength(2);
            expect(
              (yield* worktrees.records()).filter((entry) => entry.state === "active"),
            ).toHaveLength(2);
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect.each(["creation-command", "synchronous-setup", "background-setup"] as const)(
    "preserves rollback and setup ownership after %s failure",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const temporary = yield* fs.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          yield* fs.makeDirectory(`${repository}/.git`, { recursive: true });
          const calls: Array<ReadonlyArray<string>> = [];
          const failure = PlatformError.badArgument({
            module: "ChildProcess",
            method: "string",
            description: "command failed",
          });
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([], {
                runSetup: Effect.fail(failure),
                run: (_cwd, args) => {
                  calls.push(args);
                  return args[0] === "rev-parse" && args[1] === "--show-toplevel"
                    ? Effect.succeed(repository)
                    : undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            const settings = {
              ...defaultProjectSettings(),
              worktreeCreateCommand: scenario === "creation-command" ? "create" : "",
              worktreeSetupCommands: scenario === "creation-command" ? "" : "setup",
            };
            const result = yield* Effect.result(
              createCheckout(
                repository,
                undefined,
                "failure",
                settings,
                scenario === "background-setup",
              ),
            );
            if (scenario === "background-setup") {
              expect(result._tag).toBe("Success");
              if (result._tag !== "Success") return;
              const created = result.success;
              expect(
                yield* Effect.result(worktrees.awaitSetup(created.worktreePath)),
              ).toMatchObject({
                _tag: "Failure",
                failure: { operation: "ManagedWorktrees.setup" },
              });
              expect(yield* worktrees.hasDeferredSetup(created.worktreePath)).toBe(true);
              expect(yield* worktrees.records()).toEqual([created]);
              expect(calls.some((args) => args[1] === "remove")).toBe(false);
            } else {
              expect(result).toMatchObject({ _tag: "Failure" });
              expect(yield* worktrees.records()).toEqual([]);
              expect(
                calls.some(
                  (args) => args[0] === "worktree" && args[1] === "remove" && args[2] === "--force",
                ),
              ).toBe(true);
              expect(calls.some((args) => args[0] === "branch" && args[1] === "-D")).toBe(true);
            }
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect.each(["discard", "resolve"] as const)(
    "keeps a stacked landing target while its child still exists during %s",
    (operation) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const parentPath = `${temporary}/parent`;
          const childPath = `${temporary}/child`;
          for (const directory of [`${repository}/.git`, parentPath, childPath])
            yield* fileSystem.makeDirectory(directory, { recursive: true });
          const parent = {
            ...record(repository, parentPath, "agent/parent"),
            state: "landed" as const,
            landedSourceCommit: "acknowledged",
          };
          const child = {
            ...record(repository, childPath, "agent/child"),
            parentWorktreePath: parentPath,
            baseBranch: parent.branch,
          };
          const mutations: string[] = [];
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([parent, child], {
                commonDirectory: () => repository,
                run: (_cwd, args) => {
                  if (args[0] === "rev-list") return Effect.succeed("0\n");
                  if (args[0] === "worktree" || args[0] === "branch") mutations.push(args[0]);
                  return undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            const result = yield* Effect.result(
              operation === "discard"
                ? worktrees.discard(parentPath, false)
                : worktrees.cleanupResolved(parentPath),
            );
            expect(result).toMatchObject({ _tag: "Failure" });
            expect(yield* worktrees.records()).toEqual([parent, child]);
            expect(mutations).toEqual([]);
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect(
    "releases a removed worktree's landing reservations and promotes the next worktree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const firstPath = `${temporary}/first`;
          const secondPath = `${temporary}/second`;
          for (const directory of [`${repository}/.git`, firstPath, secondPath])
            yield* fileSystem.makeDirectory(directory, { recursive: true });
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer(
                [
                  record(repository, firstPath, "agent/first"),
                  record(repository, secondPath, "agent/second"),
                ],
                { commonDirectory: () => repository },
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            yield* worktrees.prepareLanding(firstPath, "first");
            const queued = yield* Deferred.make<void>();
            const second = yield* worktrees
              .prepareLanding(
                secondPath,
                "second",
                Deferred.succeed(queued, undefined).pipe(Effect.asVoid),
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(queued);
            yield* worktrees.discard(firstPath, false);
            yield* Fiber.join(second);
            expect(yield* worktrees.status(secondPath)).toMatchObject({
              landingState: "running",
              landingOperationId: "second",
            });
            yield* worktrees.cancelLanding(secondPath, "second");
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );
  it.effect.each(["land", "rebase"] as const)(
    "refuses %s after the source checkout switched branches",
    (operation) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const worktreePath = `${temporary}/source`;
          yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
          yield* fileSystem.makeDirectory(worktreePath);
          const mutations: string[] = [];
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([record(repository, worktreePath, "agent/source")], {
                commonDirectory: () => repository,
                run: (cwd, args) => {
                  if (cwd === worktreePath && args[0] === "rev-parse" && args[1] === "--abbrev-ref")
                    return Effect.succeed("unrelated\n");
                  if (args[0] === "rebase" || args[0] === "merge") mutations.push(args[0]);
                  return undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            const result = yield* Effect.result(
              operation === "land"
                ? worktrees
                    .land(worktreePath, "source", { strategy: "preserve" })
                    .pipe(Effect.asVoid)
                : worktrees.rebase(worktreePath).pipe(Effect.asVoid),
            );
            expect(result).toMatchObject({ _tag: "Failure" });
            expect(mutations).toEqual([]);
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );
  it.effect.each(["dirty", "ahead", "remove-failure", "branch-failure"] as const)(
    "preserves the record and reports unsafe or failed resolved cleanup: %s",
    (scenario) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const worktreePath = `${temporary}/source`;
          yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
          yield* fileSystem.makeDirectory(worktreePath);
          const initial: WorktreeRecord = {
            ...record(repository, worktreePath, "agent/source"),
            state: "landed",
            landedSourceCommit: "acknowledged",
          };
          const mutations: string[] = [];
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([initial], {
                commonDirectory: () => repository,
                run: (cwd, args) => {
                  if (args[0] === "status" && cwd === worktreePath)
                    return Effect.succeed(scenario === "dirty" ? "?? later.txt\n" : "");
                  if (args[0] === "rev-list")
                    return Effect.succeed(scenario === "ahead" ? "1\n" : "0\n");
                  if (
                    args[0] === "rev-parse" &&
                    args[1] === "--verify" &&
                    args[3]?.startsWith("refs/heads/")
                  )
                    return Effect.succeed("head");
                  if ((args[0] === "worktree" && args[1] === "remove") || args[0] === "branch") {
                    mutations.push(args[0]);
                    if (
                      (scenario === "remove-failure" && args[0] === "worktree") ||
                      (scenario === "branch-failure" && args[0] === "branch")
                    )
                      return Effect.fail(
                        new GitError({
                          operation: "cleanup",
                          workingDirectory: cwd,
                          message: "checkout busy",
                        }),
                      );
                  }
                  return undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            expect(yield* Effect.result(worktrees.cleanupResolved(worktreePath))).toMatchObject({
              _tag: "Failure",
            });
            expect(yield* worktrees.records()).toEqual([initial]);
            if (scenario === "dirty" || scenario === "ahead") expect(mutations).toEqual([]);
            if (scenario === "remove-failure") expect(mutations).toEqual(["worktree"]);
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect(
    "dismisses durable landing intent without resurrecting it or clearing a newer reservation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const worktreePath = `${temporary}/source`;
          yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
          yield* fileSystem.makeDirectory(worktreePath);
          const initial = {
            ...record(repository, worktreePath, "agent/source"),
            pendingStrategy: "squash" as const,
          };
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(makeLayer([initial], { commonDirectory: () => repository })),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            yield* worktrees.prepareLanding(worktreePath, "current");
            yield* worktrees.cancelLanding(worktreePath, "older");
            expect((yield* worktrees.records())[0]?.pendingStrategy).toBe("squash");
            yield* worktrees.cancelLanding(worktreePath, "current");
            expect((yield* worktrees.records())[0]?.pendingStrategy).toBeUndefined();
            expect((yield* worktrees.status(worktreePath))?.landingState).toBeUndefined();
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("accepts a requested squash proposal from durable pause metadata after restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        const worktreePath = `${temporary}/source`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
        yield* fileSystem.makeDirectory(worktreePath);
        const initial = {
          ...record(repository, worktreePath, "agent/source"),
          pendingStrategy: "squash" as const,
        };
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(makeLayer([initial], { commonDirectory: () => repository })),
        );
        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          yield* worktrees.proposeSquashMessage({
            workspacePath: worktreePath,
            subject: "Recovered squash",
          });
          expect(yield* worktrees.status(worktreePath)).toMatchObject({ squashMessageReady: true });
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect.each(["preserve", "squash"] as const)(
    "protects dirty target changes with %s landing",
    (strategy) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const worktreePath = `${temporary}/source`;
          yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
          yield* fileSystem.makeDirectory(worktreePath);
          const mutations: string[] = [];
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([record(repository, worktreePath, "agent/source")], {
                commonDirectory: () => repository,
                run: (cwd, args) => {
                  if (args[0] === "status" && cwd === repository)
                    return Effect.succeed("M  staged.txt\n");
                  if (["rebase", "merge", "commit", "reset"].includes(args[0] ?? ""))
                    mutations.push(args[0] ?? "");
                  return undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            const result = yield* Effect.result(
              worktrees.land(worktreePath, "land", {
                strategy,
                message: "Squash",
                allowDirtyTarget: true,
              }),
            );
            expect(result._tag).toBe(strategy === "squash" ? "Failure" : "Success");
            if (strategy === "squash") expect(mutations).toEqual([]);
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );
  it.effect(
    "recovers a historical source checkpoint without hiding commits made before recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const worktreePath = `${temporary}/source`;
          yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
          yield* fileSystem.makeDirectory(worktreePath);
          const initial = {
            ...record(repository, worktreePath, "agent/source"),
            state: "landed" as const,
          };
          const calls: Array<ReadonlyArray<string>> = [];
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([initial], {
                commonDirectory: () => repository,
                run: (cwd, args) => {
                  calls.push(args);
                  if (args[0] === "reflog")
                    return Effect.succeed("rewritten-target\nold-target\nbase\n");
                  if (args[0] === "merge-base" && args[1] !== "--is-ancestor")
                    return Effect.succeed(args[2] === "old-target" ? "landed-source\n" : "base\n");
                  if (args[0] === "merge-base" && args[1] === "--is-ancestor")
                    return args[2] === "base"
                      ? Effect.succeed("")
                      : Effect.fail(
                          new GitError({
                            operation: "merge-base",
                            workingDirectory: cwd,
                            message: "not ancestor",
                          }),
                        );
                  if (args[0] === "rev-list" && args.includes("^landed-source"))
                    return Effect.succeed("2\n");
                  if (args[0] === "rev-list") return Effect.succeed("18\n");
                  if (args[0] === "status" && cwd === worktreePath)
                    return Effect.succeed("?? scratch.txt\n");
                  return undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            expect(yield* worktrees.status(worktreePath)).toMatchObject({
              aheadCount: 2,
              dirtyCount: 1,
              record: { landedSourceCommit: "landed-source" },
            });
            expect(yield* worktrees.records()).toMatchObject([
              { landedSourceCommit: "landed-source" },
            ]);
            expect(
              yield* Effect.result(worktrees.land(worktreePath, "dirty", { strategy: "preserve" })),
            ).toMatchObject({ _tag: "Failure" });
            expect(calls.some((args) => args[0] === "rebase" || args[0] === "merge")).toBe(false);
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("uses the latest persisted checkpoint after waiting in the landing queue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        const worktreePath = `${temporary}/source`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
        yield* fileSystem.makeDirectory(worktreePath);
        const initial = {
          ...record(repository, worktreePath, "agent/source"),
          state: "landed" as const,
          landedSourceCommit: "old-source",
        };
        const mergeStarted = yield* Deferred.make<void>();
        const finishMerge = yield* Deferred.make<void>();
        let head = "new-source";
        const rebases: Array<ReadonlyArray<string>> = [];
        const layer = ManagedWorktreesLive.pipe(
          Layer.provide(
            makeLayer([initial], {
              commonDirectory: () => repository,
              run: (_cwd, args) => {
                if (args[0] === "rev-list" && args.length === 5)
                  return Effect.succeed(args.includes(`^${head}`) ? "0\n" : "1\n");
                if (args[0] === "rev-parse" && args[1] === "HEAD")
                  return Effect.succeed(`${head}\n`);
                if (args[0] === "rev-parse" && args[1] === "main")
                  return Effect.succeed("rewritten-target\n");
                if (args[0] === "rebase")
                  return Effect.sync(() => {
                    rebases.push(args);
                    head = "rebased-source";
                    return "";
                  });
                if (args[0] === "merge")
                  return Deferred.succeed(mergeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishMerge)),
                    Effect.as(""),
                  );
                return undefined;
              },
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          const first = yield* worktrees
            .land(worktreePath, "first", { strategy: "preserve" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(mergeStarted);
          const second = yield* worktrees
            .land(worktreePath, "second", { strategy: "preserve" })
            .pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(second.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(finishMerge, undefined);
          expect(yield* Fiber.join(first)).toMatchObject({ outcome: "landed" });
          expect(yield* Fiber.join(second)).toEqual({ outcome: "landed" });
          expect(rebases).toEqual([["rebase", "--onto", "rewritten-target", "old-source"]]);
          expect(yield* worktrees.records()).toMatchObject([
            { landedSourceCommit: "rebased-source" },
          ]);
          expect(yield* worktrees.status(worktreePath)).toMatchObject({ aheadCount: 0 });
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect.each(["preserve", "squash"] as const)(
    "checkpoints the source actually landed with %s, not commits added after the merge",
    (strategy) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const worktreePath = `${temporary}/source`;
          yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
          yield* fileSystem.makeDirectory(worktreePath);
          let sourceHead = "source-to-land";
          let targetHead = "target-before";
          const initial = {
            ...record(repository, worktreePath, "agent/source"),
            state: "landed" as const,
            landedSourceCommit: "old-source",
          };
          const layer = ManagedWorktreesLive.pipe(
            Layer.provide(
              makeLayer([initial], {
                commonDirectory: () => repository,
                run: (cwd, args) => {
                  if (args[0] === "rev-parse" && args[1] === "HEAD")
                    return Effect.succeed(cwd === worktreePath ? sourceHead : targetHead);
                  if (args[0] === "rev-parse" && args[1] === "main")
                    return Effect.succeed(targetHead);
                  if (args[0] === "merge")
                    return Effect.sync(() => {
                      if (strategy === "squash") expect(args[2]).toBe("source-to-land");
                      else targetHead = "source-to-land";
                      sourceHead = "source-after-merge";
                      return "";
                    });
                  if (args[0] === "commit")
                    return Effect.sync(() => {
                      targetHead = "squash-commit";
                      return "";
                    });
                  return undefined;
                },
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            expect(
              yield* worktrees.land(worktreePath, "land", { strategy, message: "landed patch" }),
            ).toMatchObject({ outcome: "landed" });
            expect(yield* worktrees.records()).toMatchObject([
              { landedSourceCommit: "source-to-land" },
            ]);
            expect(yield* worktrees.status(worktreePath)).toMatchObject({ aheadCount: 1 });
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect.each(["landed", "discarded"] as const)(
    "retains the landing classification of a %s worktree through resolution and restoration",
    (previousState) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const temporary = yield* fileSystem.makeTempDirectoryScoped();
          const repository = `${temporary}/repo`;
          const worktreePath = `${temporary}/worktree`;
          yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
          if (previousState === "landed")
            yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
          const initial: WorktreeRecord = {
            ...record(repository, worktreePath, "agent/restoration"),
            state: previousState,
          };
          const persisted = yield* Ref.make<ReadonlyArray<WorktreeRecord>>([initial]);
          const live = (records: ReadonlyArray<WorktreeRecord>) =>
            ManagedWorktreesLive.pipe(
              Layer.provide(
                makeLayer(records, {
                  save: (next) => Ref.set(persisted, next),
                  run: (_cwd, args) => (args[0] === "rev-list" ? Effect.succeed("0\n") : undefined),
                  onRun: (_cwd, args) => {
                    if (args[0] === "worktree" && args[1] === "remove")
                      return fileSystem
                        .remove(worktreePath, { recursive: true, force: true })
                        .pipe(Effect.orDie);
                    if (args[0] === "worktree" && args[1] === "add")
                      return fileSystem
                        .makeDirectory(worktreePath, { recursive: true })
                        .pipe(Effect.orDie);
                    return Effect.void;
                  },
                }),
              ),
            );

          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            yield* worktrees.cleanupResolved(worktreePath);
            expect(yield* worktrees.records()).toEqual([
              { ...initial, state: "resolved", resolvedFrom: previousState },
            ]);
            expect(yield* fileSystem.exists(worktreePath)).toBe(false);
          }).pipe(Effect.provide(live([initial])));

          // Reacquire the service from persisted records, as after restarting Cake.
          const retired = yield* Ref.get(persisted);
          yield* Effect.gen(function* () {
            const worktrees = yield* ManagedWorktrees;
            const updates = yield* Queue.unbounded<ManagedWorktreeCatalogUpdate>();
            yield* worktrees.observe().pipe(
              Stream.runForEach((update) => Queue.offer(updates, update)),
              Effect.forkScoped,
            );
            const catalog = WorktreeCatalog.create();
            applyManagedWorktreeCatalogUpdate(catalog, yield* Queue.take(updates));
            const projected = catalog.find(worktreePath);
            expect(projected?.state).toBe("resolved");
            expect(projected?.resolvedFrom).toBe(previousState);

            const expectedState = previousState === "landed" ? "landed" : "active";
            const restored = yield* worktrees.restoreResolved(worktreePath);
            const expectedRecord = {
              ...initial,
              state: expectedState,
              ...(previousState === "landed" ? { landedSourceCommit: "head" } : {}),
            };
            expect(restored).toEqual(expectedRecord);
            expect(yield* Ref.get(persisted)).toEqual([restored]);
            expect(yield* fileSystem.exists(worktreePath)).toBe(true);
            applyManagedWorktreeCatalogUpdate(catalog, yield* Queue.take(updates));
            expect(catalog.find(worktreePath)).toBe(projected);
            expect(projected?.state).toBe(expectedState);
            expect(projected?.resolvedFrom).toBeUndefined();
            const icon = renderToStaticMarkup(
              createElement(WorktreeStatusIcon, { state: projected?.state }),
            );
            expect(icon).toContain(
              `aria-label="${previousState === "landed" ? "Merged worktree" : "Open worktree"}"`,
            );
            if (previousState === "landed") {
              expect(yield* worktrees.status(worktreePath)).toMatchObject({
                record: { state: "landed" },
                merged: true,
              });
              // A second resolve/unresolve must preserve the classification too.
              yield* worktrees.cleanupResolved(worktreePath);
              yield* worktrees.restoreResolved(worktreePath);
              expect(yield* worktrees.records()).toEqual([expectedRecord]);
            }
          }).pipe(Effect.provide(live(retired)));
        }).pipe(Effect.provide(BootstrapLive)),
      ),
  );

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
            const queued = yield* Deferred.make<void>();
            const second = yield* worktrees
              .prepareLanding(
                secondPath,
                "second",
                Deferred.succeed(queued, undefined).pipe(Effect.asVoid),
              )
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
            yield* Deferred.await(queued);
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
          const created = yield* createCheckout(
            repository,
            undefined,
            "background",
            settings,
            true,
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
            createCheckout(repository, undefined, "rollback", undefined),
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

  it.effect("waits for an interrupted Git checkout before rolling it back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });

        let checkoutExists = false;
        let finishAdd: (() => void) | undefined;
        let markAddStarted: (() => void) | undefined;
        const addStarted = new Promise<void>((resolve) => {
          markAddStarted = resolve;
        });
        const runner: GitRunner = (_cwd, arguments_) => {
          const [command, ...args] = arguments_;
          if (command === "worktree" && args[0] === "add") {
            markAddStarted?.();
            return new Promise<string>((resolve) => {
              finishAdd = () => {
                checkoutExists = true;
                resolve("");
              };
            });
          }
          if (command === "worktree" && args[0] === "remove") {
            checkoutExists = false;
            return Promise.resolve("");
          }
          if (command === "rev-parse" && args[0] === "--show-toplevel")
            return Promise.resolve(`${repository}\n`);
          if (
            command === "rev-parse" &&
            args[0] === "--path-format=absolute" &&
            args[1] === "--git-common-dir"
          )
            return Promise.resolve(`${repository}/.git\n`);
          if (command === "rev-parse" && args[0] === "--abbrev-ref")
            return Promise.resolve("main\n");
          if (command === "rev-parse" && args[0] === "--verify")
            return Promise.reject(new Error("missing"));
          if (command === "symbolic-ref") return Promise.reject(new Error("missing"));
          if (command === "rev-parse") return Promise.resolve("head\n");
          return Promise.resolve("");
        };
        const layer = ManagedWorktreesLive.pipe(Layer.provide(makeLiveLayer([], runner)));

        yield* Effect.gen(function* () {
          const creation = yield* createCheckout(
            repository,
            undefined,
            "interrupted",
            undefined,
          ).pipe(Effect.forkScoped);
          yield* Effect.promise(() => addStarted);

          const interruption = yield* Fiber.interrupt(creation).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(interruption.pollUnsafe()).toBeUndefined();
          expect(checkoutExists).toBe(false);

          finishAdd?.();
          yield* Fiber.join(interruption);
          expect(checkoutExists).toBe(false);
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(BootstrapLive)),
  );

  it.effect("keeps an interrupted landing mutation inside its repository lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const temporary = yield* fileSystem.makeTempDirectoryScoped();
        const repository = `${temporary}/repo`;
        const worktreePath = `${temporary}/worktree`;
        yield* fileSystem.makeDirectory(`${repository}/.git`, { recursive: true });
        yield* fileSystem.makeDirectory(worktreePath, { recursive: true });

        let mutationRunning = false;
        let lockViolation = false;
        let finishRebase: (() => void) | undefined;
        let markRebaseStarted: (() => void) | undefined;
        const rebaseStarted = new Promise<void>((resolve) => {
          markRebaseStarted = resolve;
        });
        const runner: GitRunner = (_cwd, arguments_) => {
          const [command, ...args] = arguments_;
          if (command === "rebase") {
            mutationRunning = true;
            markRebaseStarted?.();
            return new Promise<string>((resolve) => {
              finishRebase = () => {
                mutationRunning = false;
                resolve("");
              };
            });
          }
          if (command === "worktree" && args[0] === "remove") {
            if (mutationRunning) lockViolation = true;
            return Promise.resolve("");
          }
          if (
            command === "rev-parse" &&
            args[0] === "--path-format=absolute" &&
            args[1] === "--git-common-dir"
          )
            return Promise.resolve(`${repository}/.git\n`);
          if (command === "rev-parse" && args[0] === "--verify")
            return Promise.reject(new Error("missing"));
          if (command === "rev-parse" && args[0] === "--git-path") return Promise.resolve("\n");
          if (command === "rev-parse" && args[0] === "--abbrev-ref")
            return Promise.resolve(_cwd === worktreePath ? "agent/interrupted\n" : "main\n");
          if (command === "rev-parse") return Promise.resolve("head\n");
          if (command === "status" || command === "diff") return Promise.resolve("");
          if (command === "rev-list") return Promise.resolve("1\n");
          return Promise.resolve("");
        };
        const initial = record(repository, worktreePath, "agent/interrupted");
        const layer = ManagedWorktreesLive.pipe(Layer.provide(makeLiveLayer([initial], runner)));

        yield* Effect.gen(function* () {
          const worktrees = yield* ManagedWorktrees;
          const landing = yield* worktrees
            .land(worktreePath, "landing", { strategy: "preserve" })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => rebaseStarted);

          const interruption = yield* Fiber.interrupt(landing).pipe(Effect.forkScoped);
          const discard = yield* worktrees.discard(worktreePath, false).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(interruption.pollUnsafe()).toBeUndefined();
          expect(discard.pollUnsafe()).toBeUndefined();
          expect(lockViolation).toBe(false);

          finishRebase?.();
          yield* Fiber.join(interruption);
          yield* Fiber.join(discard);
          expect(lockViolation).toBe(false);
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
          const creation = yield* createCheckout(
            repository,
            undefined,
            "interrupted",
            undefined,
          ).pipe(Effect.forkScoped);
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
