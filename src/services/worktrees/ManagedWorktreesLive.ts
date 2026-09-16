import {
  Cache,
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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ProjectSettings } from "../../domain/application/application-data";
import type {
  ManagedWorktreeCatalogUpdate,
  WorktreeRecord,
} from "../../domain/worktrees/managed-worktree-data";
import {
  worktreeStatusSchema,
  type WorktreeLandOutcome,
  type WorktreeLandRequest,
  type WorktreeRebaseOutcome,
  type WorktreeStatus,
} from "../../ipc/worktree-contract";
import { Git } from "../git/Git";
import { WorktreeStorage } from "../storage/WorktreeStorage";
import { ManagedWorktreeError, ManagedWorktrees } from "./ManagedWorktrees";
import { renderWorktreeCommand, type WorktreeCommandVariables } from "./worktree-command-template";

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

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const internalError = (message: string) => Effect.fail(new Error(message));
const resolveNormalized = (path: string) => path.replace(/\/+$/, "");
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree";

/** Effect-native Managed Worktree capability. Mutable authority is held in Refs,
 * repository mutations use keyed Effect Semaphores, and landing reservations use
 * interruptible Deferred queues with exact FIFO promotion. */
export const ManagedWorktreesLive: Layer.Layer<
  ManagedWorktrees,
  never,
  | Git
  | WorktreeStorage
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  ManagedWorktrees,
  Effect.gen(function* () {
    const gitService = yield* Git;
    const storage = yield* WorktreeStorage;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const initialRecords = yield* storage.load().pipe(Effect.orDie);
    const recordsRef = yield* Ref.make<ReadonlyArray<WorktreeRecord>>(initialRecords);
    const recordsLock = yield* Semaphore.make(1);
    const repositoryLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
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
    ) {
      yield* updateRecord(record, (current) => {
        const closed: WorktreeRecord = { ...current, state };
        Reflect.deleteProperty(closed, "pendingStrategy");
        return closed;
      });
    });
    const repositoryLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
      Ref.modify(repositoryLocks, (locks) => {
        const current = locks.get(key);
        if (current) return [current, locks] as const;
        const created = Semaphore.makeUnsafe(1);
        const next = new Map(locks);
        next.set(key, created);
        return [created, next] as const;
      }).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));
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
      range: string,
    ) {
      return Number.parseInt((yield* git(cwd, "rev-list", "--count", range)).trim(), 10) || 0;
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
    const defaultBranch = Effect.fn("ManagedWorktrees.defaultBranch")(function* (
      repository: string,
    ) {
      const remote = yield* gitOptional(repository, [
        "symbolic-ref",
        "-q",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      if (remote._tag === "Some") return remote.value.replace(/^origin\//, "") || "main";
      const current = yield* gitOptional(repository, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return current._tag === "Some" && current.value !== "HEAD" ? current.value : "main";
    });
    const runCommand = Effect.fn("ManagedWorktrees.runCommand")(function* (
      workingDirectory: string,
      script: string,
    ) {
      yield* spawner
        .string(
          ChildProcess.make("/bin/sh", ["-lc", `set -e\n${script}`], { cwd: workingDirectory }),
        )
        .pipe(Effect.asVoid, Effect.scoped);
    });
    const runSetup = Effect.fn("ManagedWorktrees.runSetup")(function* (
      worktreePath: string,
      settings: ProjectSettings | undefined,
      variables: WorktreeCommandVariables,
    ) {
      if (settings?.worktreeSetupCommands.trim())
        yield* runCommand(
          worktreePath,
          renderWorktreeCommand(settings.worktreeSetupCommands, variables),
        );
    });
    const availableName = Effect.fn("ManagedWorktrees.availableName")(function* (
      repository: string,
      directory: string,
      requested: string,
    ) {
      const prefix = requested.slice(0, 56).replace(/-+$/g, "") || "worktree";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const name = `${prefix}-${crypto.randomUUID().slice(0, 6)}`;
        if (
          !(yield* revParseExists(repository, `refs/heads/agent/${name}`)) &&
          !(yield* exists(path.join(directory, name)))
        )
          return name;
      }
      return yield* internalError("Cake could not generate a unique worktree name");
    });

    const createRecord = Effect.fn("ManagedWorktrees.createRecord")(function* (
      root: string,
      projectPath: string,
      baseWorktreePath: string | undefined,
      worktreeName: string | undefined,
      settings: ProjectSettings | undefined,
      setup: boolean,
    ) {
      const records = yield* Ref.get(recordsRef);
      const normalizedBase = baseWorktreePath && resolveNormalized(baseWorktreePath);
      const parent = normalizedBase
        ? records.find(
            (entry) =>
              ["active", "landed"].includes(entry.state ?? "active") &&
              resolveNormalized(entry.worktreePath) === normalizedBase,
          )
        : undefined;
      const projectBase =
        normalizedBase === projectPath || normalizedBase === resolveNormalized(root);
      if (
        normalizedBase &&
        ((!parent && !projectBase) || (parent && parent.projectPath !== projectPath))
      )
        return yield* internalError("Cake could not find that base worktree");
      const sourcePath = parent?.worktreePath ?? (projectBase ? normalizedBase : root);
      if (!sourcePath || !(yield* exists(sourcePath)))
        return yield* internalError("The base worktree no longer exists");
      const baseBranch = parent
        ? parent.branch
        : projectBase
          ? (yield* git(sourcePath, "rev-parse", "--abbrev-ref", "HEAD")).trim()
          : yield* defaultBranch(root);
      if (baseBranch === "HEAD")
        return yield* internalError("Check out a branch before creating a child worktree.");
      const baseCommit = (yield* git(
        sourcePath,
        "rev-parse",
        normalizedBase ? "HEAD" : baseBranch,
      )).trim();
      const slug = slugify(path.basename(root));
      const requestedName = worktreeName ?? slug;
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(requestedName))
        return yield* internalError("Invalid worktree name");
      const directory = path.join(path.dirname(root), `.${slug}-worktrees`);
      const name = yield* availableName(root, directory, requestedName);
      const branch = `agent/${name}`;
      const worktreePath = path.join(directory, name);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const variables = {
        projectPath,
        worktreePath,
        worktreeName: name,
        branchName: branch,
        baseBranch,
        baseCommit,
      };
      const createCheckout = Effect.gen(function* () {
        if (settings?.worktreeCreateCommand.trim()) {
          yield* runCommand(root, renderWorktreeCommand(settings.worktreeCreateCommand, variables));
          if (!(yield* exists(worktreePath)))
            return yield* internalError(
              "The worktree creation command did not create {worktreePath}",
            );
          const createdBranch = (yield* git(
            worktreePath,
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          )).trim();
          if (createdBranch !== branch)
            return yield* internalError(
              `The worktree creation command checked out ${createdBranch}, not ${branch}`,
            );
        } else yield* gitMutation(root, "worktree", "add", "-b", branch, worktreePath, baseCommit);
        if (setup) yield* runSetup(worktreePath, settings, variables);
      });
      const base = {
        projectPath,
        worktreePath,
        branch,
        baseBranch,
        baseCommit,
        state: "active" as const,
        createdAt: new Date().toISOString(),
      };
      const record: WorktreeRecord = parent
        ? { ...base, parentWorktreePath: parent.worktreePath }
        : base;
      return yield* createCheckout.pipe(
        Effect.andThen(mutateRecords((current) => [...current, record])),
        Effect.as(record),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? gitMutation(root, "worktree", "remove", "--force", worktreePath).pipe(
                Effect.ignore,
                Effect.andThen(gitMutation(root, "branch", "-D", branch).pipe(Effect.ignore)),
                Effect.andThen(
                  mutateRecords((current) => {
                    const next = current.filter(
                      (item) =>
                        resolveNormalized(item.worktreePath) !==
                        resolveNormalized(record.worktreePath),
                    );
                    return next.length === current.length ? current : next;
                  }).pipe(Effect.ignore),
                ),
              )
            : Effect.void,
        ),
      );
    });
    const createWithPolicy = Effect.fn("ManagedWorktrees.createWithPolicy")(function* (
      projectPath: string,
      baseWorktreePath: string | undefined,
      worktreeName: string | undefined,
      settings: ProjectSettings | undefined,
      setup: boolean,
    ) {
      const registered = path.resolve(projectPath);
      const root = yield* fileSystem.realPath(yield* repositoryRoot(projectPath));
      return yield* withRepositoryLock(
        root,
        createRecord(root, registered, baseWorktreePath, worktreeName, settings, setup),
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
        yield* Deferred.await(ready).pipe(
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
      const result = yield* Effect.result(gitMutation(record.worktreePath, "rebase", target));
      if (result._tag === "Success") return null;
      if (yield* rebaseInProgress(record.worktreePath))
        return yield* unmergedFiles(record.worktreePath);
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
      yield* gitMutation(targetPath, "merge", "--squash", record.branch)
        .pipe(Effect.andThen(gitMutation(targetPath, "commit", "-m", message)))
        .pipe(
          Effect.tapCause(() => gitMutation(targetPath, "reset", "--merge").pipe(Effect.ignore)),
        );
      const commit = (yield* git(targetPath, "rev-parse", "HEAD")).trim();
      yield* closeRecord(record, "landed");
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
    const landRecord = Effect.fn("ManagedWorktrees.landRecord")(function* (
      record: WorktreeRecord,
      request: WorktreeLandRequest,
    ): Effect.fn.Return<WorktreeLandOutcome, unknown, never> {
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
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      if (!(yield* exists(targetPath)))
        return yield* internalError("The worktree landing target no longer exists");
      if (
        (yield* git(targetPath, "rev-parse", "--abbrev-ref", "HEAD")).trim() !== record.baseBranch
      )
        return yield* internalError(
          `Switch the landing target back to "${record.baseBranch}" first.`,
        );
      if ((yield* dirtyFileCount(targetPath)) > 0 && !request.allowDirtyTarget)
        return yield* internalError(
          "The landing target has uncommitted changes. Commit or stash them first.",
        );
      if ((yield* revListCount(record.worktreePath, `${record.baseBranch}..HEAD`)) === 0) {
        yield* closeRecord(record, "landed");
        return { outcome: "landed" };
      }
      if (request.strategy === "squash") {
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
          yield* closeRecord(record, "landed");
          return { outcome: "landed", commit };
        }
        lastError = messageOf(merge.failure);
      }
      return yield* internalError(`Cake could not fast-forward the landing target: ${lastError}`);
    });
    const cleanup = Effect.fn("ManagedWorktrees.cleanup")(function* (
      record: WorktreeRecord,
      options: { readonly keepBranch: boolean; readonly state: "discarded" | "resolved" },
    ) {
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
      if (yield* exists(record.worktreePath))
        yield* gitMutation(
          record.projectPath,
          "worktree",
          "remove",
          "--force",
          record.worktreePath,
        ).pipe(Effect.ignore);
      yield* gitMutation(record.projectPath, "worktree", "prune").pipe(Effect.ignore);
      if (!options.keepBranch)
        yield* gitMutation(record.projectPath, "branch", "-D", record.branch).pipe(Effect.ignore);
      yield* closeRecord(record, options.state);
    });

    const records = Effect.fn("ManagedWorktrees.records")(function* () {
      return [...(yield* Ref.get(recordsRef))];
    });
    const statusInternal = Effect.fn("ManagedWorktrees.statusInternal")(function* (
      worktreePath: string,
    ): Effect.fn.Return<WorktreeStatus | undefined, unknown> {
      const normalized = resolveNormalized(worktreePath);
      const record = (yield* Ref.get(recordsRef)).find(
        (entry) => resolveNormalized(entry.worktreePath) === normalized,
      );
      if (!record || !["active", "landed"].includes(record.state ?? "active")) return undefined;
      if (!(yield* exists(record.worktreePath))) {
        yield* gitMutation(record.projectPath, "worktree", "prune").pipe(Effect.ignore);
        yield* closeRecord(record, "missing");
        return undefined;
      }
      const targetPath = record.parentWorktreePath ?? record.projectPath;
      if (!(yield* exists(targetPath)))
        return yield* internalError("The worktree landing target no longer exists");
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
          revListCount(record.worktreePath, `${record.baseBranch}..HEAD`),
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
      create: Effect.fn("ManagedWorktrees.create")(
        (projectPath, baseWorktreePath, worktreeName, settings) =>
          mapError(
            "ManagedWorktrees.create",
            createWithPolicy(projectPath, baseWorktreePath, worktreeName, settings, true).pipe(
              Effect.tap((record) => publish(record.worktreePath)),
            ),
          ),
      ),
      createWithBackgroundSetup: Effect.fn("ManagedWorktrees.createWithBackgroundSetup")(
        (projectPath, baseWorktreePath, worktreeName, settings) =>
          mapError(
            "ManagedWorktrees.createWithBackgroundSetup",
            Effect.gen(function* () {
              const record = yield* createWithPolicy(
                projectPath,
                baseWorktreePath,
                worktreeName,
                settings,
                false,
              );
              const completion = yield* Deferred.make<void, ManagedWorktreeError>();
              yield* Ref.update(deferredSetups, (setups) =>
                new Map(setups).set(record.worktreePath, completion),
              );
              yield* runSetup(record.worktreePath, settings, {
                projectPath: record.projectPath,
                worktreePath: record.worktreePath,
                worktreeName: record.branch.replace(/^agent\//, ""),
                branchName: record.branch,
                baseBranch: record.baseBranch,
                baseCommit:
                  record.baseCommit ??
                  (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim(),
              }).pipe(
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
              yield* publish(record.worktreePath);
              return record;
            }),
          ),
      ),
      awaitSetup: (worktreePath) =>
        Effect.gen(function* () {
          const completion = (yield* Ref.get(deferredSetups)).get(worktreePath);
          if (completion) yield* Deferred.await(completion);
        }),
      hasDeferredSetup: (worktreePath) =>
        Ref.get(deferredSetups).pipe(Effect.map((setups) => setups.has(worktreePath))),
      status: (worktreePath) =>
        mapError(
          "ManagedWorktrees.status",
          statusInternal(worktreePath).pipe(Effect.tap(() => publish(worktreePath))),
        ),
      prepareLanding: Effect.fn("ManagedWorktrees.prepareLanding")((worktreePath, operationId) =>
        mapError(
          "ManagedWorktrees.prepareLanding",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* acquireLanding(record, operationId);
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
            const outcome = yield* withRepositoryLock(
              record.projectPath,
              landRecord(record, request),
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
              if (record) yield* cancelLandingInternal(record, operationId, onlyIfQueued);
              else if (onlyIfQueued)
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
            return yield* withRepositoryLock(
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
                const conflicts = yield* rebaseOntoTarget(record, targetHead);
                return conflicts
                  ? ({ outcome: "resolving", files: conflicts } as const)
                  : ({ outcome: "rebased" } as const);
              }),
            );
          }),
        ),
      discard: (worktreePath, keepBranch) =>
        mapError(
          "ManagedWorktrees.discard",
          Effect.gen(function* () {
            const record = (yield* Ref.get(recordsRef)).find(
              (entry) =>
                ["active", "landed"].includes(entry.state ?? "active") &&
                resolveNormalized(entry.worktreePath) === resolveNormalized(worktreePath),
            );
            if (!record) return yield* internalError("Cake could not find that worktree");
            yield* withRepositoryLock(
              record.projectPath,
              cleanup(record, { keepBranch, state: "discarded" }),
            );
            yield* publish(worktreePath);
          }),
        ),
      cleanupResolved: (worktreePath) =>
        mapError(
          "ManagedWorktrees.cleanupResolved",
          Effect.gen(function* () {
            const normalized = resolveNormalized(worktreePath);
            const pending = (yield* Ref.get(recordsRef)).find(
              (entry) => resolveNormalized(entry.worktreePath) === normalized,
            );
            if (
              !pending ||
              !["landed", "discarded", "resolved"].includes(pending.state ?? "active")
            )
              return;
            yield* withRepositoryLock(
              pending.projectPath,
              Effect.gen(function* () {
                const record = (yield* Ref.get(recordsRef)).find(
                  (entry) => resolveNormalized(entry.worktreePath) === normalized,
                );
                if (!record || !["landed", "discarded"].includes(record.state ?? "active")) return;
                if (record.state === "landed")
                  yield* cleanup(record, { keepBranch: false, state: "resolved" });
                else yield* closeRecord(record, "resolved");
              }),
            );
            yield* publish(worktreePath);
          }),
        ),
      restoreResolved: (worktreePath) => {
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
          return yield* withRepositoryLock(
            pending.projectPath,
            Effect.gen(function* () {
              const record = (yield* Ref.get(recordsRef)).find(
                (entry) =>
                  entry.state === "resolved" &&
                  resolveNormalized(entry.worktreePath) === normalized,
              );
              if (!record) return undefined;
              if (!(yield* exists(record.worktreePath))) {
                const targetPath = record.parentWorktreePath ?? record.projectPath;
                if (!(yield* exists(targetPath)))
                  return yield* internalError("The worktree restore target no longer exists");
                yield* fileSystem.makeDirectory(path.dirname(record.worktreePath), {
                  recursive: true,
                });
                const branchExists = yield* revParseExists(
                  record.projectPath,
                  `refs/heads/${record.branch}`,
                );
                yield* gitMutation(
                  record.projectPath,
                  "worktree",
                  "add",
                  ...(branchExists ? [] : ["-b", record.branch]),
                  record.worktreePath,
                  branchExists ? record.branch : record.baseBranch,
                );
              }
              const restored = { ...record, state: "active" as const };
              yield* updateRecord(record, () => restored);
              return restored;
            }),
          );
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
            if (!awaiting)
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
