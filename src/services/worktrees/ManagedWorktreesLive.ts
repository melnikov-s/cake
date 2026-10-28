import {
  Cache,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type {
  ManagedWorktreeCatalogUpdate,
  WorktreeRecord,
} from "../../contracts/worktrees/managed-worktree-data";
import {
  worktreeStatusSchema,
  type WorktreeLandOutcome,
  type WorktreeLandRequest,
  type WorktreeRebaseOutcome,
  type WorktreeStatus,
} from "../../contracts/worktrees/worktree-contract";
import { Git } from "../git/Git";
import { WorktreeStorage, type WorktreeStorageError } from "../storage/WorktreeStorage";
import { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import {
  ManagedWorktrees,
  type WorktreeCheckoutPlan,
  type WorktreeLifecycle,
  type WorktreeRemoveReason,
} from "./ManagedWorktrees";
import { WorktreeCommands, type WorktreeCommandRequest } from "./WorktreeCommands";
import { renderWorktreeCommand } from "./worktree-command-template";

interface LandingEntry {
  readonly operationId: string;
  readonly worktreePath: string;
  readonly ready: Deferred.Deferred<void, Error>;
}
interface LandingQueue {
  readonly active: LandingEntry | undefined;
  readonly pending: ReadonlyArray<LandingEntry>;
}
interface SquashProposal {
  readonly message: string;
  readonly head: string;
  readonly targetHead: string;
}
/** Where one checkout lives and what it checks out, as substituted into lifecycle commands. */
interface CheckoutFacts {
  readonly projectPath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  readonly checkoutPath: string;
  readonly worktreePath: string;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const internalError = (message: string) => Effect.fail(new Error(message));
const resolveNormalized = (path: string) => path.replace(/\/+$/, "");
const worktreeNameOf = (branch: string) => branch.replace(/^agent\//, "");
const checkoutOf = (record: WorktreeRecord) => record.checkoutPath ?? record.worktreePath;
/** Effect-native Managed Worktree capability. Mutable authority is held in Refs,
 * repository mutations use keyed Effect Semaphores, and landing reservations use
 * interruptible Deferred queues with exact FIFO promotion. */
export const ManagedWorktreesLive: Layer.Layer<
  ManagedWorktrees,
  WorktreeStorageError,
  Git | WorktreeStorage | FileSystem.FileSystem | Path.Path | WorktreeCommands
> = Layer.effect(
  ManagedWorktrees,
  Effect.gen(function* () {
    const gitService = yield* Git;
    const storage = yield* WorktreeStorage;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const commands = yield* WorktreeCommands;
    const scope = yield* Effect.scope;
    const initialRecords = yield* storage.load();
    const recordsRef = yield* Ref.make<ReadonlyArray<WorktreeRecord>>(initialRecords);
    const recordsLock = yield* Semaphore.make(1);
    const repositoryLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
    // Serializes removal and restoration of one checkout while its slow commands run unlocked.
    const worktreeLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
    const landingQueues = yield* Ref.make(new Map<string, LandingQueue>());
    const squashProposals = yield* Ref.make(new Map<string, SquashProposal>());
    const awaitingSquashProposals = yield* Ref.make(new Set<string>());
    const deferredSetups = yield* Ref.make(
      new Map<string, Deferred.Deferred<void, ManagedWorktreeError>>(),
    );
    const changes = yield* PubSub.bounded<ManagedWorktreeCatalogUpdate>({ capacity: 1_024 });

    const mapError = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new ManagedWorktreeError({ operation, message: messageOf(cause) }),
        ),
      );
    const exists = (target: string) => fileSystem.exists(target);
    const git = Effect.fn("ManagedWorktrees.git")((cwd: string, ...args: ReadonlyArray<string>) =>
      gitService.run(cwd, args),
    );
    // GitRunner only acknowledges Promise settlement, so defer interruption for mutations until
    // settlement. Reads and repository-lock acquisition remain interruptible.
    const gitMutation = Effect.fn("ManagedWorktrees.gitMutation")(
      (cwd: string, ...args: ReadonlyArray<string>) =>
        git(cwd, ...args).pipe(Effect.uninterruptible),
    );
    const gitOptional = Effect.fn("ManagedWorktrees.gitOptional")(
      (cwd: string, args: ReadonlyArray<string>) =>
        git(cwd, ...args).pipe(
          Effect.map((value) => value.trim()),
          Effect.option,
        ),
    );
    const mutateRecords = Effect.fn("ManagedWorktrees.mutateRecords")(function* (
      change: (records: ReadonlyArray<WorktreeRecord>) => ReadonlyArray<WorktreeRecord>,
    ) {
      yield* recordsLock.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(recordsRef);
            const next = change(current);
            if (next === current) return;
            yield* restore(storage.save(next)).pipe(
              Effect.onInterrupt(() => storage.save(current).pipe(Effect.ignore)),
            );
            yield* Ref.set(recordsRef, next);
          }),
        ),
      );
    });
    const updateRecord = Effect.fn("ManagedWorktrees.updateRecord")(function* (
      record: WorktreeRecord,
      change: (record: WorktreeRecord) => WorktreeRecord,
    ) {
      yield* mutateRecords((records) => {
        const index = records.findIndex(
          (current) =>
            resolveNormalized(current.worktreePath) === resolveNormalized(record.worktreePath),
        );
        const current = records[index];
        return index < 0 || !current ? records : records.with(index, change(current));
      });
    });
    const closeRecord = Effect.fn("ManagedWorktrees.closeRecord")(function* (
      record: WorktreeRecord,
      state: "landed" | "resolved" | "discarded" | "missing",
      landedSourceCommit?: string,
    ) {
      yield* updateRecord(record, (current) => {
        const retainPreviousState =
          state === "resolved" && (current.state === "landed" || current.state === "discarded");
        const closed = {
          ...current,
          state,
          resolvedFrom: retainPreviousState ? current.state : undefined,
        } satisfies WorktreeRecord;
        if (landedSourceCommit) closed.landedSourceCommit = landedSourceCommit;
        Reflect.deleteProperty(closed, "pendingStrategy");
        if (state === "landed") Reflect.deleteProperty(closed, "pendingLandedSourceCommit");
        return closed;
      });
    });
    const keyedLock =
      (registry: Ref.Ref<Map<string, Semaphore.Semaphore>>) =>
      <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
        Ref.modify(registry, (locks) => {
          const current = locks.get(key);
          if (current) return [current, locks] as const;
          const created = Semaphore.makeUnsafe(1);
          const next = new Map(locks);
          next.set(key, created);
          return [created, next] as const;
        }).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));
    const repositoryLock = keyedLock(repositoryLocks);
    /** Always taken before, never inside, a repository lock. */
    const withWorktreeLock = <A, E, R>(worktreePath: string, effect: Effect.Effect<A, E, R>) =>
      keyedLock(worktreeLocks)(resolveNormalized(worktreePath), effect);
    const publish = Effect.fn("ManagedWorktrees.publish")(function* (worktreePath: string) {
      const record = (yield* Ref.get(recordsRef)).find(
        (item) => item.worktreePath === worktreePath,
      );
      if (record)
        yield* PubSub.publish(changes, {
          _tag: "Event",
          event: { _tag: "Upserted", worktree: record },
        });
    });
    const repositoryRoot = Effect.fn("ManagedWorktrees.repositoryRoot")(function* (
      projectPath: string,
    ) {
      return yield* git(projectPath, "rev-parse", "--show-toplevel").pipe(
        Effect.map((value) => value.trim()),
        Effect.catch(() => internalError("Worktrees require a Git repository")),
      );
    });
    const repositoryIdentityCache = yield* Cache.makeWith(
      Effect.fn("ManagedWorktrees.resolveRepositoryIdentity")(function* (workingDirectory: string) {
        const commonDirectory = (yield* git(
          workingDirectory,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        )).trim();
        return yield* fileSystem.realPath(commonDirectory);
      }),
      {
        capacity: 1_024,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );
    const repositoryIdentity = Effect.fn("ManagedWorktrees.repositoryIdentity")(
      (workingDirectory: string) => Cache.get(repositoryIdentityCache, workingDirectory),
    );
    const withRepositoryLock = Effect.fn("ManagedWorktrees.withRepositoryLock")(function* <A, E, R>(
      workingDirectory: string,
      effect: Effect.Effect<A, E, R>,
    ) {
      return yield* repositoryLock(yield* repositoryIdentity(workingDirectory), effect);
    });
    const revParseExists = Effect.fn("ManagedWorktrees.revParseExists")(function* (
      cwd: string,
      ref: string,
    ) {
      return (
        (yield* Effect.result(git(cwd, "rev-parse", "--verify", "-q", ref)))._tag === "Success"
      );
    });
    const revListCount = Effect.fn("ManagedWorktrees.revListCount")(function* (
      cwd: string,
      ...revisions: ReadonlyArray<string>
    ) {
      return (
        Number.parseInt((yield* git(cwd, "rev-list", "--count", ...revisions)).trim(), 10) || 0
      );
    });
    // Pre-checkpoint preserve landings can be recovered from target history, not patch IDs.
    // If that history has expired (or was squashed), retain the conservative target comparison.
    const withLandingCheckpoint = Effect.fn("ManagedWorktrees.withLandingCheckpoint")(function* (
      record: WorktreeRecord,
    ) {
      if (record.state !== "landed") return record;
      const pending = record.pendingLandedSourceCommit;
      if (pending && !(yield* rebaseInProgress(record.worktreePath))) {
        const completed = yield* isAncestor(record.worktreePath, pending, "HEAD");
        yield* updateRecord(record, (current) => {
          if (current.pendingLandedSourceCommit !== pending) return current;
          const next = { ...current };
          if (completed) next.landedSourceCommit = pending;
          Reflect.deleteProperty(next, "pendingLandedSourceCommit");
          return next;
        });
        record =
          (yield* Ref.get(recordsRef)).find(
            (current) => current.worktreePath === record.worktreePath,
          ) ?? record;
      }
      if (record.landedSourceCommit) return record;
      const history = yield* gitOptional(record.worktreePath, [
        "reflog",
        "show",
        "--format=%H",
        record.baseBranch,
      ]);
      let checkpoint: string | undefined;
      if (history._tag === "Some") {
        for (const tip of new Set(history.value.split("\n").filter(Boolean))) {
          const common = yield* gitOptional(record.worktreePath, ["merge-base", "HEAD", tip]);
          if (common._tag !== "Some" || !common.value) continue;
          if (!checkpoint || (yield* isAncestor(record.worktreePath, checkpoint, common.value)))
            checkpoint = common.value;
        }
      }
      if (!checkpoint) return record;
      const recovered = checkpoint;
      yield* updateRecord(record, (current) =>
        current.landedSourceCommit ? current : { ...current, landedSourceCommit: recovered },
      );
      return (
        (yield* Ref.get(recordsRef)).find(
          (current) => current.worktreePath === record.worktreePath,
        ) ?? record
      );
    });
    const newCommitCount = Effect.fn("ManagedWorktrees.newCommitCount")(function* (
      record: WorktreeRecord,
      source = "HEAD",
    ) {
      // Exclude both acknowledged source history and work already present on the target.
      return yield* revListCount(
        record.worktreePath,
        ...(record.landedSourceCommit
          ? [source, `^${record.landedSourceCommit}`, `^${record.baseBranch}`]
          : [`${record.baseBranch}..${source}`]),
      );
    });
    const dirtyFileCount = Effect.fn("ManagedWorktrees.dirtyFileCount")(function* (cwd: string) {
      return (yield* git(cwd, "status", "--porcelain"))
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
    });
    const isAncestor = Effect.fn("ManagedWorktrees.isAncestor")(function* (
      cwd: string,
      ancestor: string,
      descendant: string,
    ) {
      return (
        (yield* Effect.result(git(cwd, "merge-base", "--is-ancestor", ancestor, descendant)))
          ._tag === "Success"
      );
    });
    const rebaseInProgress = Effect.fn("ManagedWorktrees.rebaseInProgress")(function* (
      cwd: string,
    ) {
      for (const marker of ["rebase-merge", "rebase-apply"]) {
        const gitPath = yield* gitOptional(cwd, ["rev-parse", "--git-path", marker]);
        if (
          gitPath._tag === "Some" &&
          gitPath.value &&
          (yield* exists(path.resolve(cwd, gitPath.value)))
        )
          return true;
      }
      return false;
    });
    const unmergedFiles = Effect.fn("ManagedWorktrees.unmergedFiles")(function* (cwd: string) {
      return (yield* git(cwd, "diff", "--name-only", "--diff-filter=U"))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    });
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
        yield* runConfigured(
          "create",
          lifecycle.createCommand,
          facts.projectPath,
          facts,
          lifecycle,
        );
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
      return yield* Effect.gen(function* () {
        const located = yield* materializeCheckout(facts, plan.lifecycle, plan.projectSubpath);
        const record: WorktreeRecord = {
          projectPath: plan.projectPath,
          worktreePath: located.worktreePath,
          branch: plan.branch,
          baseBranch: plan.baseBranch,
          baseCommit: plan.baseCommit,
          state: "active",
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (located.checkoutPath !== located.worktreePath)
          Object.assign(record, { checkoutPath: located.checkoutPath });
        if (plan.parentWorktreePath)
          Object.assign(record, { parentWorktreePath: plan.parentWorktreePath });
        if (!backgroundSetup) yield* runSetup(record, plan.lifecycle);
        yield* mutateRecords((current) => [...current, record]);
        return record;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? rollbackCreation(root, facts, plan.projectSubpath, plan.lifecycle)
            : Effect.void,
        ),
      );
    });

    const landingState = Effect.fn("ManagedWorktrees.landingState")(function* (
      record: WorktreeRecord,
    ) {
      const queue = (yield* Ref.get(landingQueues)).get(
        yield* repositoryIdentity(record.projectPath),
      );
      if (!queue) return undefined;
      const normalized = resolveNormalized(record.worktreePath);
      if (queue.active?.worktreePath === normalized)
        return { state: "running" as const, operationId: queue.active.operationId };
      const index = queue.pending.findIndex((entry) => entry.worktreePath === normalized);
      const entry = queue.pending[index];
      return entry
        ? { state: "queued" as const, operationId: entry.operationId, position: index + 1 }
        : undefined;
    });
    const releaseLanding = Effect.fn("ManagedWorktrees.releaseLanding")(function* (
      record: WorktreeRecord,
      operationId: string,
    ) {
      const repository = yield* repositoryIdentity(record.projectPath);
      const promoted = yield* Ref.modify(landingQueues, (queues) => {
        const queue = queues.get(repository);
        if (!queue || queue.active?.operationId !== operationId)
          return [undefined, queues] as const;
        const [nextActive, ...pending] = queue.pending;
        const next = new Map(queues);
        if (nextActive) next.set(repository, { active: nextActive, pending });
        else next.delete(repository);
        return [nextActive?.ready, next] as const;
      });
      if (promoted) yield* Deferred.succeed(promoted, undefined);
    });
    const acquireLanding = Effect.fn("ManagedWorktrees.acquireLanding")(function* (
      record: WorktreeRecord,
      operationId: string,
      onQueued?: Effect.Effect<void>,
    ) {
      const ready = yield* Deferred.make<void, Error>();
      const entry: LandingEntry = {
        operationId,
        worktreePath: resolveNormalized(record.worktreePath),
        ready,
      };
      const repository = yield* repositoryIdentity(record.projectPath);
      const wait = yield* Ref.modify(landingQueues, (queues) => {
        const current = queues.get(repository);
        if (current?.active?.operationId === operationId) return [false, queues] as const;
        const next = new Map(queues);
        if (!current) next.set(repository, { active: entry, pending: [] });
        else next.set(repository, { ...current, pending: [...current.pending, entry] });
        return [current !== undefined, next] as const;
      });
      if (wait)
        yield* (onQueued ?? Effect.void).pipe(
          Effect.andThen(Deferred.await(ready)),
          Effect.onInterrupt(() => cancelLandingInternal(record, operationId, false)),
        );
    });
    const cancelLandingInternal = Effect.fn("ManagedWorktrees.cancelLandingInternal")(function* (
      record: WorktreeRecord,
      operationId: string,
      onlyIfQueued: boolean,
    ) {
      const repository = yield* repositoryIdentity(record.projectPath);
      const result = yield* Ref.modify<
        Map<string, LandingQueue>,
        "missing" | "active" | { readonly _tag: "pending"; readonly entry: LandingEntry }
      >(landingQueues, (queues) => {
        const queue = queues.get(repository);
        if (!queue) return ["missing" as const, queues] as const;
        if (queue.active?.operationId === operationId) return ["active" as const, queues] as const;
        const index = queue.pending.findIndex((entry) => entry.operationId === operationId);
        if (index < 0) return ["missing" as const, queues] as const;
        const entry = queue.pending[index];
        if (!entry) return ["missing" as const, queues] as const;
        const next = new Map(queues);
        next.set(repository, {
          ...queue,
          pending: queue.pending.filter((_, itemIndex) => itemIndex !== index),
        });
        return [{ _tag: "pending" as const, entry }, next] as const;
      });
      if (result === "active") {
        if (onlyIfQueued)
          return yield* internalError("This merge has already started and cannot be canceled.");
        yield* releaseLanding(record, operationId);
      } else if (result === "missing") {
        if (onlyIfQueued)
          return yield* internalError("This merge has already started and cannot be canceled.");
      } else if (result.entry)
        yield* Deferred.fail(result.entry.ready, new Error("Worktree landing was canceled."));
      return result !== "missing";
    });

    const rememberPendingLanding = Effect.fn("ManagedWorktrees.rememberPendingLanding")(function* (
      record: WorktreeRecord,
      strategy: WorktreeLandRequest["strategy"],
    ) {
      if (record.pendingStrategy !== strategy)
        yield* updateRecord(record, (current) => ({ ...current, pendingStrategy: strategy }));
    });
    const dryRunConflicts = Effect.fn("ManagedWorktrees.dryRunConflicts")(function* (
      root: string,
      baseBranch: string,
      branch: string,
    ) {
      const result = yield* Effect.result(
        gitMutation(root, "merge-tree", "--write-tree", "--name-only", baseBranch, branch),
      );
      if (result._tag === "Success") return [];
      const cause = result.failure;
      const stdout = cause instanceof Error && "stdout" in cause ? String(cause.stdout) : "";
      if (!stdout) return null;
      return stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean);
    });
    const rebaseOntoTarget = Effect.fn("ManagedWorktrees.rebaseOntoTarget")(function* (
      record: WorktreeRecord,
      target = record.baseBranch,
    ) {
      const current =
        (yield* Ref.get(recordsRef)).find((entry) => entry.worktreePath === record.worktreePath) ??
        record;
      const targetHead = (yield* git(record.worktreePath, "rev-parse", target)).trim();
      const result = yield* Effect.result(
        gitMutation(
          record.worktreePath,
          "rebase",
          ...(current.landedSourceCommit
            ? ["--onto", targetHead, current.landedSourceCommit]
            : [targetHead]),
        ),
      );
      const resolving = result._tag === "Failure" && (yield* rebaseInProgress(record.worktreePath));
      if (current.landedSourceCommit && (result._tag === "Success" || resolving))
        yield* updateRecord(current, (entry) => {
          const next = { ...entry };
          if (resolving) next.pendingLandedSourceCommit = targetHead;
          else {
            next.landedSourceCommit = targetHead;
            Reflect.deleteProperty(next, "pendingLandedSourceCommit");
          }
          return next;
        });
      if (result._tag === "Success") return null;
      if (resolving) return yield* unmergedFiles(record.worktreePath);
      return yield* internalError(
        `Cake could not replay the worktree commits onto the target branch: ${messageOf(result.failure)}`,
      );
    });
    const hasFreshProposal = Effect.fn("ManagedWorktrees.hasFreshProposal")(function* (
      record: WorktreeRecord,
    ) {
      const proposal = (yield* Ref.get(squashProposals)).get(
        resolveNormalized(record.worktreePath),
      );
      if (!proposal) return false;
      const head = (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim();
      if (proposal.head !== head) return false;
      const targetHead = (yield* git(
        record.parentWorktreePath ?? record.projectPath,
        "rev-parse",
        "HEAD",
      )).trim();
      return proposal.targetHead === targetHead;
    });
    const consumeProposal = Effect.fn("ManagedWorktrees.consumeProposal")(function* (
      record: WorktreeRecord,
      targetPath: string,
    ) {
      const normalized = resolveNormalized(record.worktreePath);
      const proposal = yield* Ref.modify(squashProposals, (proposals) => {
        const current = proposals.get(normalized);
        const next = new Map(proposals);
        next.delete(normalized);
        return [current, next] as const;
      });
      if (!proposal) return undefined;
      const head = (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim();
      const targetHead = (yield* git(targetPath, "rev-parse", "HEAD")).trim();
      return proposal.head === head && proposal.targetHead === targetHead
        ? proposal.message
        : undefined;
    });
    const squashMerge = Effect.fn("ManagedWorktrees.squashMerge")(function* (
      record: WorktreeRecord,
      message: string,
    ) {
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      const sourceCommit = (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim();
      yield* gitMutation(targetPath, "merge", "--squash", sourceCommit)
        .pipe(Effect.andThen(gitMutation(targetPath, "commit", "-m", message)))
        .pipe(
          Effect.tapCause(() => gitMutation(targetPath, "reset", "--merge").pipe(Effect.ignore)),
        );
      const commit = (yield* git(targetPath, "rev-parse", "HEAD")).trim();
      yield* closeRecord(record, "landed", sourceCommit);
      return commit;
    });
    const landSquash = Effect.fn("ManagedWorktrees.landSquash")(function* (
      record: WorktreeRecord,
      message: string | undefined,
    ): Effect.fn.Return<WorktreeLandOutcome, unknown, never> {
      const normalized = resolveNormalized(record.worktreePath);
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      if (message) {
        const head = (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim();
        const targetHead = (yield* git(targetPath, "rev-parse", "HEAD")).trim();
        yield* Ref.update(squashProposals, (proposals) =>
          new Map(proposals).set(normalized, { message, head, targetHead }),
        );
      }
      const conflicts = yield* dryRunConflicts(targetPath, record.baseBranch, record.branch);
      if (conflicts === null || conflicts.length > 0) {
        yield* gitMutation(
          record.worktreePath,
          "merge",
          "--no-ff",
          "--no-edit",
          record.baseBranch,
        ).pipe(Effect.ignore);
        if (yield* revParseExists(record.worktreePath, "MERGE_HEAD")) {
          yield* Ref.update(awaitingSquashProposals, (items) => new Set(items).add(normalized));
          return {
            outcome: "resolving",
            files: conflicts ?? (yield* unmergedFiles(record.worktreePath)),
          };
        }
      }
      const requested = yield* consumeProposal(record, targetPath);
      if (!requested) {
        yield* Ref.update(awaitingSquashProposals, (items) => new Set(items).add(normalized));
        return { outcome: "proposal" };
      }
      return { outcome: "landed", commit: yield* squashMerge(record, requested) };
    });
    const requireSourceBranch = Effect.fn("ManagedWorktrees.requireSourceBranch")(function* (
      record: WorktreeRecord,
    ) {
      const branch = (yield* git(record.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).trim();
      if (branch !== record.branch)
        return yield* internalError(`Switch the source worktree back to "${record.branch}" first.`);
    });
    const landRecord = Effect.fn("ManagedWorktrees.landRecord")(function* (
      record: WorktreeRecord,
      request: WorktreeLandRequest,
    ): Effect.fn.Return<WorktreeLandOutcome, unknown, never> {
      // Queue waiters must use the checkpoint committed by the preceding landing.
      record =
        (yield* Ref.get(recordsRef)).find((entry) => entry.worktreePath === record.worktreePath) ??
        record;
      if (!(yield* exists(record.worktreePath))) {
        yield* closeRecord(record, "missing");
        return yield* internalError("The worktree no longer exists on disk");
      }
      if (
        (yield* rebaseInProgress(record.worktreePath)) ||
        (yield* revParseExists(record.worktreePath, "MERGE_HEAD"))
      ) {
        yield* rememberPendingLanding(record, request.strategy);
        return { outcome: "resolving", files: yield* unmergedFiles(record.worktreePath) };
      }
      if ((yield* dirtyFileCount(record.worktreePath)) > 0)
        return yield* internalError(
          "The worktree has uncommitted changes. Commit or discard them first.",
        );
      yield* requireSourceBranch(record);
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      if (!(yield* exists(targetPath)))
        return yield* internalError("The worktree landing target no longer exists");
      if (
        (yield* git(targetPath, "rev-parse", "--abbrev-ref", "HEAD")).trim() !== record.baseBranch
      )
        return yield* internalError(
          `Switch the landing target back to "${record.baseBranch}" first.`,
        );
      // Squash commits the target index wholesale; it cannot preserve unrelated staged work.
      if (
        (yield* dirtyFileCount(targetPath)) > 0 &&
        (!request.allowDirtyTarget || request.strategy === "squash")
      )
        return yield* internalError(
          "The landing target has uncommitted changes. Commit or stash them first.",
        );
      record = yield* withLandingCheckpoint(record);
      const sourceCommit = (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim();
      if ((yield* newCommitCount(record, sourceCommit)) === 0) {
        yield* closeRecord(record, "landed", sourceCommit);
        return { outcome: "landed" };
      }
      if (request.strategy === "squash") {
        if (record.landedSourceCommit) {
          const conflicts = yield* rebaseOntoTarget(record);
          if (conflicts) {
            yield* rememberPendingLanding(record, "squash");
            return { outcome: "resolving", files: conflicts };
          }
        }
        const outcome = yield* landSquash(record, request.message);
        if (outcome.outcome !== "landed") yield* rememberPendingLanding(record, "squash");
        return outcome;
      }
      let lastError = "unknown Git failure";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const conflicts = yield* rebaseOntoTarget(record);
        if (conflicts) {
          yield* rememberPendingLanding(record, "preserve");
          return { outcome: "resolving", files: conflicts };
        }
        const merge = yield* Effect.result(
          gitMutation(targetPath, "merge", "--ff-only", record.branch),
        );
        if (merge._tag === "Success") {
          const commit = (yield* git(targetPath, "rev-parse", "HEAD")).trim();
          yield* closeRecord(record, "landed", commit);
          return { outcome: "landed", commit };
        }
        lastError = messageOf(merge.failure);
      }
      return yield* internalError(`Cake could not fast-forward the landing target: ${lastError}`);
    });
    /** Removes the checkout with its project's command outside the repository lock, then
     * updates the branch and record under it. */
    const cleanup = Effect.fn("ManagedWorktrees.cleanup")(function* (
      record: WorktreeRecord,
      options: {
        readonly keepBranch: boolean;
        readonly state: "discarded" | "resolved";
        readonly reason: WorktreeRemoveReason;
        readonly lifecycle: WorktreeLifecycle;
      },
    ) {
      const normalized = resolveNormalized(record.worktreePath);
      const dependents = (yield* Ref.get(recordsRef)).filter(
        (entry) =>
          entry.parentWorktreePath !== undefined &&
          resolveNormalized(entry.parentWorktreePath) === normalized &&
          ["active", "landed"].includes(entry.state ?? "active"),
      );
      for (const child of dependents)
        if (yield* exists(child.worktreePath))
          return yield* internalError(
            "Remove child worktrees before removing their landing target.",
          );
      yield* Ref.update(awaitingSquashProposals, (items) => {
        const next = new Set(items);
        next.delete(normalized);
        return next;
      });
      yield* Ref.update(squashProposals, (items) => {
        const next = new Map(items);
        next.delete(normalized);
        return next;
      });
      const facts = factsOf(record);
      if (yield* exists(facts.checkoutPath))
        yield* removeCheckout(facts, options.lifecycle, options.reason);
      else if (!options.lifecycle.removeCommand)
        yield* gitMutation(record.projectPath, "worktree", "prune");
      yield* withRepositoryLock(
        record.projectPath,
        Effect.gen(function* () {
          if (
            !options.keepBranch &&
            (yield* revParseExists(record.projectPath, `refs/heads/${record.branch}`))
          )
            yield* gitMutation(record.projectPath, "branch", "-D", record.branch);
          yield* closeRecord(record, options.state);
        }),
      );
      // Removed checkouts cannot retain reservations, including a paused squash landing.
      const queue = (yield* Ref.get(landingQueues)).get(
        yield* repositoryIdentity(record.projectPath),
      );
      for (const pending of queue?.pending ?? [])
        if (pending.worktreePath === normalized)
          yield* cancelLandingInternal(record, pending.operationId, false);
      if (queue?.active?.worktreePath === normalized)
        yield* releaseLanding(record, queue.active.operationId);
    });

    const records = Effect.fn("ManagedWorktrees.records")(function* () {
      return [...(yield* Ref.get(recordsRef))];
    });
    const statusInternal = Effect.fn("ManagedWorktrees.statusInternal")(function* (
      worktreePath: string,
    ): Effect.fn.Return<WorktreeStatus | undefined, unknown> {
      const normalized = resolveNormalized(worktreePath);
      let record = (yield* Ref.get(recordsRef)).find(
        (entry) => resolveNormalized(entry.worktreePath) === normalized,
      );
      if (!record || !["active", "landed"].includes(record.state ?? "active")) return undefined;
      if (!(yield* exists(record.worktreePath))) {
        yield* closeRecord(record, "missing");
        return undefined;
      }
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      if (!(yield* exists(targetPath)))
        return yield* internalError("The worktree landing target no longer exists");
      record = yield* withLandingCheckpoint(record);
      const [
        dirtyCount,
        aheadCount,
        behindCount,
        merged,
        targetDirty,
        targetBranch,
        merging,
        rebasing,
      ] = yield* Effect.all(
        [
          dirtyFileCount(record.worktreePath),
          newCommitCount(record),
          revListCount(record.worktreePath, `HEAD..${record.baseBranch}`),
          record.state === "landed"
            ? Effect.succeed(true)
            : isAncestor(record.worktreePath, "HEAD", record.baseBranch),
          dirtyFileCount(targetPath).pipe(Effect.map((count) => count > 0)),
          gitOptional(targetPath, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
            Effect.map((value) => (value._tag === "Some" ? value.value : undefined)),
          ),
          revParseExists(record.worktreePath, "MERGE_HEAD"),
          rebaseInProgress(record.worktreePath),
        ] as const,
        { concurrency: "unbounded" },
      );
      const landing = yield* landingState(record);
      return yield* Schema.decodeUnknownEffect(worktreeStatusSchema)({
        record,
        targetBranch: record.baseBranch,
        dirtyCount,
        aheadCount,
        behindCount,
        merged,
        targetDirty,
        targetOnBranch: targetBranch === record.baseBranch,
        merging,
        rebasing,
        squashMessageReady: yield* hasFreshProposal(record),
        ...(landing?.state === "queued"
          ? {
              landingState: landing.state,
              landingOperationId: landing.operationId,
              landingQueuePosition: landing.position,
            }
          : landing
            ? { landingState: landing.state, landingOperationId: landing.operationId }
            : {}),
      });
    });

    const service = ManagedWorktrees.of({
      records,
      observe: () =>
        Stream.unwrap(
          PubSub.subscribe(changes).pipe(
            Effect.map((subscription) =>
              Stream.fromEffect(
                records().pipe(
                  Effect.map((worktrees) => ({ _tag: "Snapshot" as const, worktrees })),
                ),
              ).pipe(Stream.concat(Stream.fromSubscription(subscription))),
            ),
          ),
        ),
      createCheckout: Effect.fn("ManagedWorktrees.createCheckout")(function* (
        projectPath: string,
        prepare: (
          repository: string,
          registeredProjectPath: string,
          records: ReadonlyArray<WorktreeRecord>,
        ) => Effect.Effect<
          WorktreeCheckoutPlan,
          ManagedWorktreeError,
          Git | FileSystem.FileSystem | Path.Path
        >,
        backgroundSetup: boolean,
      ) {
        const operation = backgroundSetup
          ? "ManagedWorktrees.createWithBackgroundSetup"
          : "ManagedWorktrees.create";
        return yield* mapError(
          operation,
          Effect.gen(function* () {
            const registered = path.resolve(projectPath);
            const root = yield* fileSystem.realPath(yield* repositoryRoot(projectPath));
            // Planning and the branch that reserves its name share the repository lock; the
            // checkout and setup commands, which can be slow, run outside it.
            const plan = yield* withRepositoryLock(
              root,
              Effect.gen(function* () {
                const plan = yield* prepare(root, registered, yield* Ref.get(recordsRef)).pipe(
                  Effect.provideService(Git, gitService),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                );
                yield* gitMutation(root, "branch", "--no-track", plan.branch, plan.baseCommit);
                return plan;
              }),
            );
            const record = yield* createRecord(root, plan, backgroundSetup);
            if (backgroundSetup) {
              const completion = yield* Deferred.make<void, ManagedWorktreeError>();
              yield* Ref.update(deferredSetups, (setups) =>
                new Map(setups).set(record.worktreePath, completion),
              );
              yield* runSetup(record, plan.lifecycle).pipe(
                (effect) => mapError("ManagedWorktrees.setup", effect),
                Effect.matchEffect({
                  onSuccess: () =>
                    Deferred.succeed(completion, undefined).pipe(
                      Effect.andThen(
                        Ref.update(deferredSetups, (setups) => {
                          const next = new Map(setups);
                          next.delete(record.worktreePath);
                          return next;
                        }),
                      ),
                      Effect.asVoid,
                    ),
                  onFailure: (error) =>
                    Deferred.fail(completion, error).pipe(
                      Effect.andThen(Effect.logError("Managed Worktree setup failed", error)),
                      Effect.asVoid,
                    ),
                }),
                Effect.forkIn(scope),
              );
            }
            yield* publish(record.worktreePath);
            return record;
          }),
        );
      }),
      awaitSetup: (worktreePath) =>
        Effect.gen(function* () {
          const completion = (yield* Ref.get(deferredSetups)).get(worktreePath);
          if (!completion) return;
          // A failed setup is reported to the starts already waiting, then forgotten so a later
          // start can use the worktree as it is.
          yield* Deferred.await(completion).pipe(
            Effect.tapError(() =>
              Ref.update(deferredSetups, (setups) => {
                if (setups.get(worktreePath) !== completion) return setups;
                const next = new Map(setups);
                next.delete(worktreePath);
                return next;
              }),
            ),
          );
        }),
      status: (worktreePath) =>
        mapError(
          "ManagedWorktrees.status",
          statusInternal(worktreePath).pipe(Effect.tap(() => publish(worktreePath))),
        ),
      prepareLanding: Effect.fn("ManagedWorktrees.prepareLanding")(
        (worktreePath, operationId, onQueued) =>
          mapError(
            "ManagedWorktrees.prepareLanding",
            Effect.gen(function* () {
              const record = (yield* Ref.get(recordsRef)).find(
                (entry) =>
                  ["active", "landed"].includes(entry.state ?? "active") &&
                  resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
              );
              if (!record) return yield* internalError("Cake could not find that worktree");
              yield* acquireLanding(record, operationId, onQueued);
            }),
          ),
      ),
      setResolveAfterLanding: (worktreePath, enabled) =>
        mapError(
          "ManagedWorktrees.setResolveAfterLanding",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) => resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* updateRecord(record, (current) => {
              const next = { ...current };
              if (enabled) next.resolveAfterLanding = true;
              else Reflect.deleteProperty(next, "resolveAfterLanding");
              return next;
            });
            yield* publish(worktreePath);
          }),
        ),
      land: (worktreePath, operationId, request) =>
        mapError(
          "ManagedWorktrees.land",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* acquireLanding(record, operationId);
            // The worktree lock keeps removal of this checkout from interleaving with landing.
            const outcome = yield* withWorktreeLock(
              record.worktreePath,
              withRepositoryLock(record.projectPath, landRecord(record, request)),
            ).pipe(Effect.tapCause(() => releaseLanding(record, operationId)));
            if (outcome.outcome === "landed") yield* releaseLanding(record, operationId);
            yield* publish(worktreePath);
            return outcome;
          }),
        ),
      cancelLanding: Effect.fn("ManagedWorktrees.cancelLanding")(
        (worktreePath, operationId, onlyIfQueued = false) =>
          mapError(
            "ManagedWorktrees.cancelLanding",
            Effect.gen(function* () {
              const record = (yield* Ref.get(recordsRef)).find(
                (entry) =>
                  resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
              );
              if (record) {
                const canceled = yield* cancelLandingInternal(record, operationId, onlyIfQueued);
                if (canceled && !onlyIfQueued) {
                  // Dismissal must abandon the durable pause too, or inspect will adopt it again.
                  yield* updateRecord(record, (current) => {
                    const next = { ...current };
                    Reflect.deleteProperty(next, "pendingStrategy");
                    return next;
                  });
                  const normalized = resolveNormalized(record.worktreePath);
                  yield* Ref.update(awaitingSquashProposals, (items) => {
                    const next = new Set(items);
                    next.delete(normalized);
                    return next;
                  });
                  yield* Ref.update(squashProposals, (items) => {
                    const next = new Map(items);
                    next.delete(normalized);
                    return next;
                  });
                  yield* publish(worktreePath);
                }
              } else if (onlyIfQueued)
                return yield* internalError(
                  "This merge has already started and cannot be canceled.",
                );
            }),
          ),
      ),
      rebase: (worktreePath) =>
        mapError(
          "ManagedWorktrees.rebase",
          Effect.gen(function* (): Effect.fn.Return<WorktreeRebaseOutcome, unknown, never> {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            return yield* withWorktreeLock(
              record.worktreePath,
              withRepositoryLock(
                record.projectPath,
                Effect.gen(function* () {
                  if (!(yield* exists(record.worktreePath))) {
                    yield* closeRecord(record, "missing");
                    return yield* internalError("The worktree no longer exists on disk");
                  }
                  if (yield* rebaseInProgress(record.worktreePath))
                    return {
                      outcome: "resolving" as const,
                      files: yield* unmergedFiles(record.worktreePath),
                    };
                  if ((yield* dirtyFileCount(record.worktreePath)) > 0)
                    return yield* internalError(
                      "The worktree has uncommitted changes. Commit or discard them first.",
                    );
                  yield* requireSourceBranch(record);
                  const targetPath = record.parentWorktreePath ?? record.projectPath;
                  if (!(yield* exists(targetPath)))
                    return yield* internalError("The worktree rebase target no longer exists");
                  const targetHead = (yield* git(
                    record.worktreePath,
                    "rev-parse",
                    record.baseBranch,
                  )).trim();
                  if ((yield* revListCount(record.worktreePath, `HEAD..${targetHead}`)) === 0)
                    return { outcome: "rebased" as const };
                  const checkpointRecord = yield* withLandingCheckpoint(record);
                  const conflicts = yield* rebaseOntoTarget(checkpointRecord, targetHead);
                  return conflicts
                    ? ({ outcome: "resolving", files: conflicts } as const)
                    : ({ outcome: "rebased" } as const);
                }),
              ),
            );
          }),
        ),
      discard: (worktreePath, keepBranch, lifecycle) =>
        mapError(
          "ManagedWorktrees.discard",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* withWorktreeLock(
              record.worktreePath,
              cleanup(record, { keepBranch, state: "discarded", reason: "discard", lifecycle }),
            );
            yield* publish(worktreePath);
          }),
        ),
      cleanupResolved: (worktreePath, options) =>
        mapError(
          "ManagedWorktrees.cleanupResolved",
          Effect.gen(function* () {
            const normalized = resolveNormalized(worktreePath);
            const eligible = (record: WorktreeRecord | undefined): record is WorktreeRecord =>
              record !== undefined &&
              (record.state === "landed" ||
                record.state === "discarded" ||
                (options.retireActive && (record.state ?? "active") === "active"));
            const find = Effect.map(Ref.get(recordsRef), (records) =>
              records.find((entry) => resolveNormalized(entry.worktreePath) === normalized),
            );
            const pending = yield* find;
            if (!eligible(pending)) return false;
            const retired = yield* withWorktreeLock(
              pending.worktreePath,
              Effect.gen(function* () {
                // Decide under the repository lock; the removal command itself runs outside it.
                const decision = yield* withRepositoryLock(
                  pending.projectPath,
                  Effect.gen(function* () {
                    const record = yield* find;
                    if (!eligible(record)) return undefined;
                    if (record.state === "discarded") {
                      yield* closeRecord(record, "resolved");
                      return undefined;
                    }
                    const landed = record.state === "landed";
                    if (!(yield* exists(record.worktreePath)))
                      return { record, keepBranch: !landed };
                    const blocked =
                      (yield* dirtyFileCount(record.worktreePath)) > 0 ||
                      (yield* rebaseInProgress(record.worktreePath)) ||
                      (yield* revParseExists(record.worktreePath, "MERGE_HEAD"));
                    if (landed) {
                      const checkpoint = yield* withLandingCheckpoint(record);
                      if (blocked || (yield* newCommitCount(checkpoint)) > 0)
                        return yield* internalError(
                          "The worktree has unlanded work. Land or explicitly discard it before cleanup.",
                        );
                      return { record, keepBranch: false };
                    }
                    // Unlanded work is never forced away. Without uncommitted changes the checkout is
                    // disposable; its branch keeps any commits for review or a later restore.
                    if (blocked) return undefined;
                    const commits = yield* revListCount(
                      record.worktreePath,
                      `${record.baseCommit ?? record.baseBranch}..refs/heads/${record.branch}`,
                    );
                    return { record, keepBranch: commits > 0 };
                  }),
                );
                if (decision)
                  yield* cleanup(decision.record, {
                    keepBranch: decision.keepBranch,
                    state: "resolved",
                    reason: "resolve",
                    lifecycle: options.lifecycle,
                  });
                return decision !== undefined || pending.state === "discarded";
              }),
            );
            yield* publish(worktreePath);
            return retired;
          }),
        ),
      restoreResolved: (worktreePath, lifecycle) => {
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
              return yield* internalError(
                `${record.branch} is already checked out at ${existing}.`,
              );
            const createdBranch = yield* withRepositoryLock(
              record.projectPath,
              Effect.gen(function* () {
                if (yield* revParseExists(record.projectPath, `refs/heads/${record.branch}`))
                  return false;
                yield* gitMutation(
                  record.projectPath,
                  "branch",
                  "--no-track",
                  record.branch,
                  record.baseBranch,
                );
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
                      const checkoutPath = yield* checkoutForBranch(
                        record.projectPath,
                        record.branch,
                      );
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
                        Effect.logWarning(
                          "Cake could not roll back a failed worktree restore",
                          cause,
                        ),
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
          yield* updateRecord(record, () => restored);
          return restored;
        });
        return mapError(
          "ManagedWorktrees.restoreResolved",
          restore(worktreePath).pipe(Effect.tap(() => publish(worktreePath))),
        );
      },
      proposeSquashMessage: (input) =>
        mapError(
          "ManagedWorktrees.proposeSquashMessage",
          Effect.gen(function* () {
            const normalized = resolveNormalized(input.workspacePath);
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === normalized,
            );
            if (!record)
              return yield* internalError("Cake could not find a worktree for this workspace");
            if (yield* revParseExists(record.worktreePath, "MERGE_HEAD"))
              return yield* internalError(
                "Complete the in-progress merge before proposing the squash message",
              );
            if (yield* rebaseInProgress(record.worktreePath))
              return yield* internalError(
                "Complete the in-progress rebase before proposing the squash message",
              );
            const awaiting = yield* Ref.modify(awaitingSquashProposals, (items) => {
              const found = items.has(normalized);
              const next = new Set(items);
              next.delete(normalized);
              return [found, next] as const;
            });
            if (!awaiting && record.pendingStrategy !== "squash")
              return yield* internalError(
                "No worktree landing is waiting for a squash commit message",
              );
            const head = (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim();
            const targetHead = (yield* git(
              record.parentWorktreePath ?? record.projectPath,
              "rev-parse",
              "HEAD",
            )).trim();
            yield* Ref.update(squashProposals, (proposals) =>
              new Map(proposals).set(normalized, {
                message: input.body ? `${input.subject}\n\n${input.body}` : input.subject,
                head,
                targetHead,
              }),
            );
          }),
        ),
    });
    return service;
  }),
);
