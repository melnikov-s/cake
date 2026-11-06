import { Effect, Ref } from "effect";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import type {
  WorktreeLandOutcome,
  WorktreeLandRequest,
} from "../../contracts/worktrees/worktree-contract";
import type { WorktreeStorageError } from "../storage/WorktreeStorage";
import type { ManagedWorktrees } from "./ManagedWorktrees";
import type { WorktreeRepository } from "./WorktreeRepository";

interface SquashProposal {
  readonly message: string;
  readonly head: string;
  readonly targetHead: string;
}

const internalError = (message: string) => Effect.fail(new Error(message));
const resolveNormalized = (path: string) => path.replace(/\/+$/, "");
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Landing execution and pause/proposal state; called under the catalog owner's locks. */
export const makeWorktreeLanding = Effect.fn("ManagedWorktrees.makeLanding")(function* (
  repository: WorktreeRepository,
  recordsRef: Ref.Ref<ReadonlyArray<WorktreeRecord>>,
  updateRecord: (
    record: WorktreeRecord,
    change: (record: WorktreeRecord) => WorktreeRecord,
  ) => Effect.Effect<void, WorktreeStorageError>,
  closeRecord: (
    record: WorktreeRecord,
    state: "landed" | "resolved" | "discarded" | "missing",
    landedSourceCommit?: string,
  ) => Effect.Effect<void, WorktreeStorageError>,
) {
  const {
    git,
    gitMutation,
    gitOptional,
    exists,
    revParseExists,
    revListCount,
    dirtyFileCount,
    isAncestor,
    rebaseInProgress,
    unmergedFiles,
  } = repository;
  const squashProposals = yield* Ref.make(new Map<string, SquashProposal>());
  const awaitingSquashProposals = yield* Ref.make(new Set<string>());
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
    const proposal = (yield* Ref.get(squashProposals)).get(resolveNormalized(record.worktreePath));
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
      .pipe(Effect.tapCause(() => gitMutation(targetPath, "reset", "--merge").pipe(Effect.ignore)));
    const commit = (yield* git(targetPath, "rev-parse", "HEAD")).trim();
    yield* closeRecord(record, "landed", sourceCommit);
    return commit;
  });
  const landSquash = Effect.fn("ManagedWorktrees.landSquash")(function* (
    record: WorktreeRecord,
    message: string | undefined,
    prepareOnly: boolean,
  ): Effect.fn.Return<WorktreeLandOutcome | { readonly outcome: "ready" }, unknown, never> {
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
    if (prepareOnly && (yield* hasFreshProposal(record))) return { outcome: "ready" };
    const requested = prepareOnly ? undefined : yield* consumeProposal(record, targetPath);
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
    prepareOnly = false,
  ): Effect.fn.Return<WorktreeLandOutcome | { readonly outcome: "ready" }, unknown, never> {
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
      !prepareOnly &&
      (yield* git(targetPath, "rev-parse", "--abbrev-ref", "HEAD")).trim() !== record.baseBranch
    )
      return yield* internalError(
        `Switch the landing target back to "${record.baseBranch}" first.`,
      );
    // Squash commits the target index wholesale; it cannot preserve unrelated staged work.
    if (
      !prepareOnly &&
      (yield* dirtyFileCount(targetPath)) > 0 &&
      (!request.allowDirtyTarget || request.strategy === "squash")
    )
      return yield* internalError(
        "The landing target has uncommitted changes. Commit or stash them first.",
      );
    record = yield* withLandingCheckpoint(record);
    const sourceCommit = (yield* git(record.worktreePath, "rev-parse", "HEAD")).trim();
    if ((yield* newCommitCount(record, sourceCommit)) === 0) {
      if (prepareOnly) return { outcome: "ready" };
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
      const outcome = yield* landSquash(record, request.message, prepareOnly);
      if (outcome.outcome !== "landed" && outcome.outcome !== "ready")
        yield* rememberPendingLanding(record, "squash");
      return outcome;
    }
    let lastError = "unknown Git failure";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const conflicts = yield* rebaseOntoTarget(record);
      if (conflicts) {
        yield* rememberPendingLanding(record, "preserve");
        return { outcome: "resolving", files: conflicts };
      }
      if (prepareOnly) return { outcome: "ready" };
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
  const clearProposal = Effect.fn("ManagedWorktrees.clearProposal")(function* (
    record: WorktreeRecord,
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
  });
  const proposeSquashMessage = Effect.fn("ManagedWorktrees.proposeSquashMessageInternal")(
    function* (input: Parameters<ManagedWorktrees["Service"]["proposeSquashMessage"]>[0]) {
      const normalized = resolveNormalized(input.workspacePath);
      const record = (yield* Ref.get(recordsRef)).find(
        (entry) =>
          ["active", "landed"].includes(entry.state ?? "active") &&
          resolveNormalized(entry.worktreePath) === normalized,
      );
      if (!record) return yield* internalError("Cake could not find a worktree for this workspace");
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
        return yield* internalError("No worktree landing is waiting for a squash commit message");
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
    },
  );
  return {
    withLandingCheckpoint,
    newCommitCount,
    rebaseOntoTarget,
    requireSourceBranch,
    hasFreshProposal,
    landRecord,
    clearProposal,
    proposeSquashMessage,
  };
});
