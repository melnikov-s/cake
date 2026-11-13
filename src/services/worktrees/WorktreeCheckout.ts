import { DateTime, Effect, Exit, FileSystem, Path, Ref } from "effect";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import type { WorktreeStorageError } from "../storage/WorktreeStorage";
import type {
  WorktreeCheckoutPlan,
  WorktreeLifecycle,
  WorktreeRemoveReason,
} from "./ManagedWorktrees";
import { WorktreeCommands, type WorktreeCommandRequest } from "./WorktreeCommands";
import { renderWorktreeCommand } from "./worktree-command-template";
import type { WorktreeRepository } from "./WorktreeRepository";
import { makeContributionRepository } from "./WorktreeContribution";

/** Where one checkout lives and what it checks out, as substituted into lifecycle commands. */
interface CheckoutFacts {
  readonly projectPath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly checkoutPath: string;
  readonly worktreePath: string;
}

const internalError = (message: string) => Effect.fail(new Error(message));
const resolveNormalized = (path: string) => path.replace(/\/+$/, "");
const worktreeNameOf = (branch: string) => branch.replace(/^agent\//, "");
const checkoutOf = (record: WorktreeRecord) => record.checkoutPath ?? record.worktreePath;

/** Configured checkout lifecycle, including creation/restore rollback, under the owning catalog. */
export const makeWorktreeCheckout = Effect.fn("ManagedWorktrees.makeCheckout")(function* (
  repository: WorktreeRepository,
  recordsRef: Ref.Ref<ReadonlyArray<WorktreeRecord>>,
  mutateRecords: (
    change: (records: ReadonlyArray<WorktreeRecord>) => ReadonlyArray<WorktreeRecord>,
  ) => Effect.Effect<void, WorktreeStorageError>,
  updateRecord: (
    record: WorktreeRecord,
    change: (record: WorktreeRecord) => WorktreeRecord,
  ) => Effect.Effect<void, WorktreeStorageError>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commands = yield* WorktreeCommands;
  const { git, gitMutation, exists, withRepositoryLock, withWorktreeLock, revParseExists } =
    repository;
  const factsOf = (record: WorktreeRecord): CheckoutFacts => ({
    projectPath: record.projectPath,
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseCommit: record.baseCommit ?? "",
    checkoutPath: checkoutOf(record),
    worktreePath: record.worktreePath,
  });
  const subpathOf = (record: WorktreeRecord) =>
    record.checkoutPath ? path.relative(record.checkoutPath, record.worktreePath) : "";
  /** The same checkout facts for a checkout Git found somewhere else. */
  const relocated = (facts: CheckoutFacts, checkoutPath: string, subpath: string) => ({
    ...facts,
    checkoutPath,
    worktreePath: subpath ? path.join(checkoutPath, subpath) : checkoutPath,
  });
  const runConfigured = Effect.fn("ManagedWorktrees.runConfigured")(function* (
    label: "create" | "setup" | "remove",
    template: string,
    workingDirectory: string,
    facts: CheckoutFacts,
    lifecycle: WorktreeLifecycle,
    removeReason = "",
  ) {
    const request = {
      label,
      script: renderWorktreeCommand(template, {
        projectPath: facts.projectPath,
        worktreePath: facts.worktreePath,
        checkoutPath: facts.checkoutPath,
        worktreeName: worktreeNameOf(facts.branch),
        branchName: facts.branch,
        baseBranch: facts.baseBranch,
        baseCommit: facts.baseCommit,
        removeReason,
      }),
      workingDirectory,
      logName: worktreeNameOf(facts.branch),
    } satisfies WorktreeCommandRequest;
    yield* commands.run(
      lifecycle.timeout === undefined ? request : { ...request, timeout: lifecycle.timeout },
    );
  });
  /** Git, not the configured command, reports where a branch is checked out. */
  const checkoutForBranch = Effect.fn("ManagedWorktrees.checkoutForBranch")(function* (
    workingDirectory: string,
    branch: string,
  ) {
    let current: string | undefined;
    for (const line of (yield* git(workingDirectory, "worktree", "list", "--porcelain")).split(
      "\n",
    )) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
      else if (current && line === `branch refs/heads/${branch}`) {
        const checkoutPath = current;
        return yield* fileSystem
          .realPath(checkoutPath)
          .pipe(Effect.orElseSucceed(() => checkoutPath));
      }
    }
    return undefined;
  });
  /** Runs the configured (or built-in) create command for an existing branch, then locates the
   * checkout it made and the project's directory inside it. */
  const materializeCheckout = Effect.fn("ManagedWorktrees.materializeCheckout")(function* (
    facts: CheckoutFacts,
    lifecycle: WorktreeLifecycle,
    subpath: string,
  ) {
    if (lifecycle.createCommand)
      yield* runConfigured("create", lifecycle.createCommand, facts.projectPath, facts, lifecycle);
    else {
      yield* fileSystem.makeDirectory(path.dirname(facts.checkoutPath), { recursive: true });
      yield* gitMutation(facts.projectPath, "worktree", "add", facts.checkoutPath, facts.branch);
    }
    const checkoutPath = yield* checkoutForBranch(facts.projectPath, facts.branch);
    if (!checkoutPath)
      return yield* internalError(
        `The worktree create command finished, but no checkout has ${facts.branch} checked out.`,
      );
    const located = relocated(facts, checkoutPath, subpath);
    if (!(yield* exists(located.worktreePath)))
      return yield* internalError(
        `The new checkout at ${checkoutPath} does not contain ${subpath}.`,
      );
    return located;
  });
  const removeCheckout = Effect.fn("ManagedWorktrees.removeCheckout")(function* (
    facts: CheckoutFacts,
    lifecycle: WorktreeLifecycle,
    reason: WorktreeRemoveReason,
  ) {
    if (lifecycle.removeCommand)
      yield* runConfigured(
        "remove",
        lifecycle.removeCommand,
        facts.projectPath,
        facts,
        lifecycle,
        reason,
      );
    else {
      // Resolution never forces: Git itself refuses to delete uncommitted or untracked work.
      yield* gitMutation(
        facts.projectPath,
        "worktree",
        "remove",
        ...(reason === "resolve" ? [] : ["--force"]),
        facts.checkoutPath,
      );
      yield* gitMutation(facts.projectPath, "worktree", "prune");
    }
    // Configured tools may report success without removing anything.
    if (yield* exists(facts.checkoutPath))
      return yield* internalError(
        `The worktree remove command finished, but ${facts.checkoutPath} still exists.`,
      );
  });
  const runSetup = Effect.fn("ManagedWorktrees.runSetup")(function* (
    record: WorktreeRecord,
    lifecycle: WorktreeLifecycle,
  ) {
    if (lifecycle.setupCommand)
      yield* runConfigured(
        "setup",
        lifecycle.setupCommand,
        record.worktreePath,
        factsOf(record),
        lifecycle,
      );
  });
  const rollbackCreation = Effect.fn("ManagedWorktrees.rollbackCreation")(function* (
    root: string,
    facts: CheckoutFacts,
    subpath: string,
    lifecycle: WorktreeLifecycle,
  ) {
    // The branch was reserved for this creation, so any checkout of it is this creation's.
    const checkoutPath = yield* checkoutForBranch(facts.projectPath, facts.branch).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (checkoutPath)
      yield* removeCheckout(relocated(facts, checkoutPath, subpath), lifecycle, "rollback").pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Cake could not remove a failed worktree checkout", cause),
        ),
      );
    yield* withRepositoryLock(root, gitMutation(root, "branch", "-D", facts.branch)).pipe(
      Effect.ignore,
    );
    yield* mutateRecords((current) => {
      const next = current.filter(
        (item) => item.projectPath !== facts.projectPath || item.branch !== facts.branch,
      );
      return next.length === current.length ? current : next;
    }).pipe(Effect.ignore);
  });
  const createRecord = Effect.fn("ManagedWorktrees.createRecord")(function* (
    root: string,
    plan: WorktreeCheckoutPlan,
    backgroundSetup: boolean,
  ) {
    const facts = relocated(
      {
        projectPath: plan.projectPath,
        branch: plan.branch,
        baseBranch: plan.baseBranch,
        baseCommit: plan.baseCommit,
        checkoutPath: plan.checkoutPath,
        worktreePath: plan.checkoutPath,
      },
      plan.checkoutPath,
      plan.projectSubpath,
    );
    const contributionRef = `refs/cake/contributions/${crypto.randomUUID()}`;
    return yield* Effect.gen(function* () {
      const located = yield* materializeCheckout(facts, plan.lifecycle, plan.projectSubpath);
      const record: WorktreeRecord = {
        projectPath: plan.projectPath,
        worktreePath: located.worktreePath,
        branch: plan.branch,
        baseBranch: plan.baseBranch,
        baseCommit: plan.baseCommit,
        contributionRef,
        state: "active",
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (located.checkoutPath !== located.worktreePath)
        Object.assign(record, { checkoutPath: located.checkoutPath });
      if (plan.parentWorktreePath)
        Object.assign(record, { parentWorktreePath: plan.parentWorktreePath });
      const contribution = makeContributionRepository(record.projectPath, repository.gitService);
      if (record.contributionRef)
        yield* contribution.initialize(record.contributionRef, plan.baseCommit);
      if (!backgroundSetup) yield* runSetup(record, plan.lifecycle);
      yield* mutateRecords((current) => [...current, record]);
      return record;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? rollbackCreation(root, facts, plan.projectSubpath, plan.lifecycle).pipe(
              Effect.ensuring(
                gitMutation(root, "update-ref", "-d", contributionRef).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "Cake could not remove a provisional contribution root",
                      error,
                    ),
                  ),
                ),
              ),
            )
          : Effect.void,
      ),
    );
  });

  const restoreResolved = Effect.fn("ManagedWorktrees.restoreCheckout")(function* (
    worktreePath: string,
    lifecycle: WorktreeLifecycle,
  ) {
    const restore = Effect.fn("ManagedWorktrees.restoreResolvedInternal")(function* (
      target: string,
    ): Effect.fn.Return<WorktreeRecord | undefined, unknown> {
      const normalized = resolveNormalized(target);
      const pending = (yield* Ref.get(recordsRef)).find(
        (entry) => resolveNormalized(entry.worktreePath) === normalized,
      );
      if (!pending) return undefined;
      if (pending.parentWorktreePath && !(yield* exists(pending.parentWorktreePath)))
        yield* restore(pending.parentWorktreePath);
      return yield* withWorktreeLock(target, restoreRecord(normalized));
    });
    const restoreRecord = Effect.fn("ManagedWorktrees.restoreRecord")(function* (
      normalized: string,
    ): Effect.fn.Return<WorktreeRecord | undefined, unknown> {
      const record = (yield* Ref.get(recordsRef)).find(
        (entry) =>
          entry.state === "resolved" && resolveNormalized(entry.worktreePath) === normalized,
      );
      if (!record) return undefined;
      let recreatedSourceCommit: string | undefined;
      if (!(yield* exists(record.worktreePath))) {
        const targetPath = record.parentWorktreePath ?? record.projectPath;
        if (!(yield* exists(targetPath)))
          return yield* internalError("The worktree restore target no longer exists");
        const facts = factsOf(record);
        const existing = yield* checkoutForBranch(record.projectPath, record.branch);
        if (existing)
          return yield* internalError(`${record.branch} is already checked out at ${existing}.`);
        const createdBranch = yield* withRepositoryLock(
          record.projectPath,
          Effect.gen(function* () {
            if (yield* revParseExists(record.projectPath, `refs/heads/${record.branch}`))
              return false;
            if (record.contributionRef) {
              const contribution = makeContributionRepository(
                record.projectPath,
                repository.gitService,
              );
              yield* contribution.prepareImport(
                record.contributionRef,
                record.baseBranch,
                record.landedSourceCommit,
              );
            }
            yield* gitMutation(
              record.projectPath,
              "branch",
              "--no-track",
              record.branch,
              record.baseBranch,
            );
            if (record.contributionRef) {
              const contribution = makeContributionRepository(
                record.projectPath,
                repository.gitService,
              );
              yield* contribution.finishImport(
                record.contributionRef,
                `refs/heads/${record.branch}`,
              );
            }
            return true;
          }),
        );
        const tip = (yield* git(
          record.projectPath,
          "rev-parse",
          `refs/heads/${record.branch}`,
        )).trim();
        yield* Effect.gen(function* () {
          const located = yield* materializeCheckout(
            { ...facts, baseCommit: tip },
            lifecycle,
            subpathOf(record),
          );
          // Pi stores sessions by Working Directory, so they need their original path.
          const original = yield* fileSystem
            .realPath(record.worktreePath)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (original !== located.worktreePath)
            return yield* internalError(
              `The worktree create command restored ${record.branch} at ${located.checkoutPath}, not ${facts.checkoutPath}.`,
            );
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.gen(function* () {
                  const checkoutPath = yield* checkoutForBranch(record.projectPath, record.branch);
                  if (checkoutPath)
                    yield* removeCheckout(
                      relocated(facts, checkoutPath, subpathOf(record)),
                      lifecycle,
                      "rollback",
                    );
                  if (createdBranch)
                    yield* withRepositoryLock(
                      record.projectPath,
                      gitMutation(record.projectPath, "branch", "-D", record.branch),
                    );
                }).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Cake could not roll back a failed worktree restore", cause),
                  ),
                )
              : Effect.void,
          ),
        );
        if (createdBranch && record.resolvedFrom === "landed") recreatedSourceCommit = tip;
      }
      const restored = {
        ...record,
        state: record.resolvedFrom === "landed" ? "landed" : "active",
        resolvedFrom: undefined,
      } satisfies WorktreeRecord;
      if (recreatedSourceCommit) restored.landedSourceCommit = recreatedSourceCommit;
      if (record.contributionRef)
        yield* withRepositoryLock(
          record.projectPath,
          makeContributionRepository(record.projectPath, repository.gitService).clearRetirement(
            record.contributionRef,
          ),
        );
      yield* updateRecord(record, () => restored);
      return restored;
    });

    return yield* restore(worktreePath);
  });
  return { factsOf, removeCheckout, runSetup, createRecord, restoreResolved };
});
