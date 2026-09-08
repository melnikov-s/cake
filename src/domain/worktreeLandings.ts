import { Cause, Effect, FiberMap, SubscriptionRef } from "effect";
import type { WorktreeLandRequest, WorktreeStatus } from "../ipc/worktree-contract";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import { WorktreeLandingAgent } from "../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCoordinator } from "../services/worktrees/WorktreeLandingCoordinator";
import {
  WorktreeLandingError,
  type WorktreeLandingOperation,
  type WorktreeLandingSnapshot,
} from "./worktree-landing-data";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const asError = (operation: string) =>
  Effect.mapError(
    (cause: unknown) => new WorktreeLandingError({ operation, message: messageOf(cause) }),
  );

const isTerminal = (operation: WorktreeLandingOperation) =>
  operation.phase === "landed" || operation.phase === "complete" || operation.phase === "failed";

const update = Effect.fn("WorktreeLandings.update")(function* (
  workspacePath: string,
  operationId: string,
  change: (operation: WorktreeLandingOperation) => WorktreeLandingOperation,
) {
  const coordinator = yield* WorktreeLandingCoordinator;
  yield* SubscriptionRef.update(coordinator.state, (state) => {
    const current = state.operations.get(workspacePath);
    if (!current || current.operationId !== operationId) return state;
    const operations = new Map(state.operations);
    operations.set(workspacePath, change(current));
    return { operations };
  });
});

const requireStatus = Effect.fn("WorktreeLandings.requireStatus")(function* (
  workspacePath: string,
) {
  const status = yield* (yield* ManagedWorktrees).status(workspacePath).pipe(asError("status"));
  if (status) return status;
  return yield* new WorktreeLandingError({
    operation: "status",
    message: "Cake could not find that worktree",
  });
});

const listedFiles = (files: ReadonlyArray<string>) =>
  files.length > 0
    ? files.map((file) => `- ${file}`).join("\n")
    : "- Run `git status` to list the conflicted files.";

const commitPrompt = (target: string) =>
  [
    `Cake is preparing to merge this worktree into ${target}, but it has uncommitted changes.`,
    "",
    "Inspect the complete working tree, verify the change, and commit all intended work with an appropriate commit message.",
    "",
    "Do not merge, rebase, push, switch branches, or modify the target checkout. Cake will merge the committed branch after this turn finishes.",
  ].join("\n");

const rebaseConflictPrompt = (target: string, files: ReadonlyArray<string>) =>
  [
    `Cake tried to rebase this worktree onto ${target}, but the deterministic rebase stopped on conflicts in these files:`,
    "",
    listedFiles(files),
    "",
    "Resolve each conflict, preserving the intent of both sides.",
    "Stage the resolved files and continue with `GIT_EDITOR=true git rebase --continue` until the rebase is complete.",
    "",
    "Do not push, merge, switch branches, or rewrite commit messages.",
  ].join("\n");

const conflictPrompt = (
  target: string,
  strategy: WorktreeLandRequest["strategy"],
  files: ReadonlyArray<string>,
) =>
  strategy === "squash"
    ? [
        `Cake is preparing to squash this worktree into ${target} as one commit, but the combined change conflicts with ${target}.`,
        "Git stopped on conflicts in these files:",
        "",
        listedFiles(files),
        "",
        "1. Resolve the conflicts in the working tree, preserving the intent of both sides.",
        "2. Complete the in-progress merge with `git commit --no-edit`.",
        `3. Inspect the complete change against ${target}, then propose one commit message for it with the Cake \`worktrees.proposeSquashMessage\` tool (a subject and optional body).`,
        "",
        "Do not push, rebase, or switch branches, and do not touch the target checkout. Cake will finish the landing.",
      ].join("\n")
    : [
        `Cake is landing this worktree into ${target} by replaying its commits on top of ${target}.`,
        "The rebase stopped on conflicts in these files:",
        "",
        listedFiles(files),
        "",
        "Resolve each conflict in the working tree, preserving the intent of both sides.",
        "Stage the resolved files and continue the rebase with `GIT_EDITOR=true git rebase --continue` until the rebase is complete.",
        "",
        "Do not push, merge, or switch branches, and do not rewrite commit messages. Cake will finish the landing.",
      ].join("\n");

const squashPrompt = (target: string) =>
  [
    `Cake is preparing to squash this worktree into ${target} as one commit.`,
    "",
    `Inspect the complete change (for example \`git log --reverse ${target}..HEAD\`, \`git diff --stat ${target}...HEAD\`, and file contents where needed), then propose one commit message describing the entire resulting change with the Cake \`worktrees.proposeSquashMessage\` tool: a concise subject line plus an optional body.`,
    "",
    "Do not modify Git state; Cake will create the commit.",
  ].join("\n");

const prompt = Effect.fn("WorktreeLandings.prompt")(function* (
  operation: WorktreeLandingOperation,
  text: string,
) {
  yield* (yield* WorktreeLandingAgent)
    .promptAndWait({ sessionId: operation.sessionId, text })
    .pipe(asError("prompt"));
});

const landingBlocked = (status: WorktreeStatus, strategy: WorktreeLandRequest["strategy"]) =>
  status.dirtyCount > 0 ||
  status.merging ||
  status.rebasing ||
  status.aheadCount === 0 ||
  (strategy === "squash" && !status.squashMessageReady);

const performLanding: (
  operation: WorktreeLandingOperation,
) => Effect.Effect<
  void,
  WorktreeLandingError,
  ManagedWorktrees | WorktreeLandingAgent | WorktreeLandingCoordinator
> = Effect.fn("WorktreeLandings.performLanding")(function* (operation) {
  const worktrees = yield* ManagedWorktrees;
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: "landing",
    pauseReason: undefined,
  }));
  const request: WorktreeLandRequest = {
    strategy: operation.strategy ?? "preserve",
    allowDirtyTarget: operation.allowDirtyTarget || undefined,
  };
  const outcome = yield* worktrees
    .land(operation.workspacePath, operation.operationId, request)
    .pipe(asError("land"));
  if (outcome.outcome === "landed") {
    yield* update(operation.workspacePath, operation.operationId, (current) => ({
      ...current,
      phase: "landed",
      pauseReason: undefined,
    }));
    return;
  }
  const status = yield* requireStatus(operation.workspacePath);
  const reason = outcome.outcome === "proposal" ? "squash-message" : "conflict";
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: outcome.outcome === "proposal" ? "proposing" : "resolving",
    pauseReason: reason,
  }));
  yield* prompt(
    operation,
    outcome.outcome === "proposal"
      ? squashPrompt(status.targetBranch)
      : conflictPrompt(status.targetBranch, request.strategy, outcome.files),
  );
  const refreshed = yield* requireStatus(operation.workspacePath);
  if (landingBlocked(refreshed, request.strategy)) {
    yield* update(operation.workspacePath, operation.operationId, (current) => ({
      ...current,
      phase: "stalled",
      pauseReason: reason,
    }));
    return;
  }
  yield* performLanding(operation);
});

const prepareCommitAndLand = Effect.fn("WorktreeLandings.prepareCommitAndLand")(function* (
  operation: WorktreeLandingOperation,
) {
  const worktrees = yield* ManagedWorktrees;
  yield* worktrees
    .prepareLanding(operation.workspacePath, operation.operationId)
    .pipe(asError("prepareLanding"));
  const status = yield* requireStatus(operation.workspacePath);
  if (status.dirtyCount === 0) return yield* performLanding(operation);
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: "committing",
    pauseReason: "commit",
  }));
  yield* prompt(operation, commitPrompt(status.targetBranch));
  const refreshed = yield* requireStatus(operation.workspacePath);
  if (landingBlocked(refreshed, operation.strategy ?? "preserve")) {
    yield* update(operation.workspacePath, operation.operationId, (current) => ({
      ...current,
      phase: "stalled",
      pauseReason: "commit",
    }));
    return;
  }
  yield* performLanding(operation);
});

const prepareAndLand = Effect.fn("WorktreeLandings.prepareAndLand")(function* (
  operation: WorktreeLandingOperation,
) {
  yield* (yield* ManagedWorktrees)
    .prepareLanding(operation.workspacePath, operation.operationId)
    .pipe(asError("prepareLanding"));
  yield* performLanding(operation);
});

const adoptLanding = Effect.fn("WorktreeLandings.adoptLanding")(function* (
  operation: WorktreeLandingOperation,
  ready: boolean,
) {
  yield* (yield* ManagedWorktrees)
    .prepareLanding(operation.workspacePath, operation.operationId)
    .pipe(asError("prepareLanding"));
  if (ready) return yield* performLanding(operation);
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: "stalled",
  }));
});

const performRebase = Effect.fn("WorktreeLandings.performRebase")(function* (
  operation: WorktreeLandingOperation,
) {
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: "rebasing",
    pauseReason: undefined,
  }));
  const outcome = yield* (yield* ManagedWorktrees)
    .rebase(operation.workspacePath)
    .pipe(asError("rebase"));
  if (outcome.outcome === "rebased") {
    yield* update(operation.workspacePath, operation.operationId, (current) => ({
      ...current,
      phase: "complete",
    }));
    return;
  }
  const status = yield* requireStatus(operation.workspacePath);
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: "resolving-rebase",
    pauseReason: "rebase-conflict",
  }));
  yield* prompt(operation, rebaseConflictPrompt(status.targetBranch, outcome.files));
  const refreshed = yield* requireStatus(operation.workspacePath);
  if (
    refreshed.dirtyCount > 0 ||
    refreshed.merging ||
    refreshed.rebasing ||
    refreshed.behindCount > 0
  ) {
    yield* update(operation.workspacePath, operation.operationId, (current) => ({
      ...current,
      phase: "stalled",
      pauseReason: "rebase-conflict",
    }));
    return;
  }
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: "complete",
  }));
});

const run = Effect.fn("WorktreeLandings.run")(function* (
  operation: WorktreeLandingOperation,
  worker: Effect.Effect<
    void,
    WorktreeLandingError,
    ManagedWorktrees | WorktreeLandingAgent | WorktreeLandingCoordinator
  >,
) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const supervised = worker.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (operation.kind === "landing")
          yield* (yield* ManagedWorktrees)
            .cancelLanding(operation.workspacePath, operation.operationId)
            .pipe(Effect.ignore);
        yield* update(operation.workspacePath, operation.operationId, (current) => ({
          ...current,
          phase: "failed",
          error: error.message,
        }));
      }),
    ),
    Effect.tapCause((cause) =>
      Effect.logError("Managed Worktree landing workflow failed", Cause.pretty(cause)),
    ),
  );
  yield* FiberMap.run(coordinator.fibers, operation.workspacePath, supervised);
});

const insert = Effect.fn("WorktreeLandings.insert")(function* (
  operation: WorktreeLandingOperation,
) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const inserted = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.operations.get(operation.workspacePath);
    if (current && !isTerminal(current)) return [false, state] as const;
    const operations = new Map(state.operations);
    operations.set(operation.workspacePath, operation);
    return [true, { operations }] as const;
  });
  if (!inserted)
    return yield* new WorktreeLandingError({
      operation: "start",
      message: "A worktree operation is already in progress.",
    });
});

export const start = Effect.fn("WorktreeLandings.start")(function* (input: {
  readonly operationId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly strategy: WorktreeLandRequest["strategy"];
  readonly allowDirtyTarget: boolean;
  readonly commitBeforeLanding: boolean;
}) {
  yield* requireStatus(input.workspacePath);
  const operation: WorktreeLandingOperation = {
    operationId: input.operationId,
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    kind: "landing",
    phase: "waiting",
    strategy: input.strategy,
    allowDirtyTarget: input.allowDirtyTarget,
  };
  yield* insert(operation);
  yield* run(
    operation,
    input.commitBeforeLanding ? prepareCommitAndLand(operation) : prepareAndLand(operation),
  );
  return operation;
});

export const startRebase = Effect.fn("WorktreeLandings.startRebase")(function* (input: {
  readonly operationId: string;
  readonly workspacePath: string;
  readonly sessionId: string;
}) {
  yield* requireStatus(input.workspacePath);
  const operation: WorktreeLandingOperation = {
    operationId: input.operationId,
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    kind: "rebase",
    phase: "rebasing",
    allowDirtyTarget: false,
  };
  yield* insert(operation);
  yield* run(operation, performRebase(operation));
  return operation;
});

export const retry = Effect.fn("WorktreeLandings.retry")(function* (input: {
  readonly workspacePath: string;
  readonly sessionId: string;
}) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const status = yield* requireStatus(input.workspacePath);
  const operation = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.operations.get(input.workspacePath);
    if (!current || current.phase !== "stalled") return [undefined, state] as const;
    const retryPhase =
      current.pauseReason === "rebase-conflict"
        ? "rebasing"
        : current.pauseReason === "commit"
          ? "committing"
          : current.pauseReason === "squash-message"
            ? "proposing"
            : "resolving";
    const claimed: WorktreeLandingOperation = {
      ...current,
      sessionId: input.sessionId,
      phase: retryPhase,
      error: undefined,
    };
    const operations = new Map(state.operations);
    operations.set(input.workspacePath, claimed);
    return [claimed, { operations }] as const;
  });
  if (!operation)
    return yield* new WorktreeLandingError({
      operation: "retry",
      message: "No paused worktree operation is waiting to retry.",
    });
  const worker =
    operation.pauseReason === "rebase-conflict"
      ? performRebase(operation)
      : operation.pauseReason === "commit"
        ? Effect.gen(function* () {
            yield* update(operation.workspacePath, operation.operationId, (item) => ({
              ...item,
              phase: "committing",
            }));
            yield* prompt(operation, commitPrompt(status.targetBranch));
            const refreshed = yield* requireStatus(operation.workspacePath);
            if (landingBlocked(refreshed, operation.strategy ?? "preserve")) {
              yield* update(operation.workspacePath, operation.operationId, (item) => ({
                ...item,
                phase: "stalled",
              }));
              return;
            }
            yield* performLanding(operation);
          })
        : Effect.gen(function* () {
            const reason = operation.pauseReason ?? "conflict";
            yield* update(operation.workspacePath, operation.operationId, (item) => ({
              ...item,
              phase: reason === "squash-message" ? "proposing" : "resolving",
            }));
            yield* prompt(
              operation,
              reason === "squash-message"
                ? squashPrompt(status.targetBranch)
                : conflictPrompt(status.targetBranch, operation.strategy ?? "preserve", []),
            );
            const refreshed = yield* requireStatus(operation.workspacePath);
            if (landingBlocked(refreshed, operation.strategy ?? "preserve")) {
              yield* update(operation.workspacePath, operation.operationId, (item) => ({
                ...item,
                phase: "stalled",
              }));
              return;
            }
            yield* performLanding(operation);
          });
  yield* run(operation, worker);
  return operation;
});

export const cancel = Effect.fn("WorktreeLandings.cancel")(function* (workspacePath: string) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const current = (yield* SubscriptionRef.get(coordinator.state)).operations.get(workspacePath);
  if (!current) return;
  yield* FiberMap.remove(coordinator.fibers, workspacePath);
  if (current.kind === "landing")
    yield* (yield* ManagedWorktrees)
      .cancelLanding(workspacePath, current.operationId)
      .pipe(asError("cancel"));
  yield* SubscriptionRef.update(coordinator.state, (state) => {
    const operations = new Map(state.operations);
    operations.delete(workspacePath);
    return { operations };
  });
});

export const inspect = Effect.fn("WorktreeLandings.inspect")(function* (input: {
  readonly workspacePath: string;
  readonly sessionId: string;
}) {
  const worktrees = yield* ManagedWorktrees;
  const coordinator = yield* WorktreeLandingCoordinator;
  const status = yield* worktrees.status(input.workspacePath).pipe(asError("inspect"));
  let operation = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
    input.workspacePath,
  );
  if (!operation && status && (status.record.pendingStrategy || status.rebasing)) {
    const strategy = status.record.pendingStrategy;
    const proposing = strategy === "squash" && !status.merging && !status.rebasing;
    const ready = strategy !== undefined && !landingBlocked(status, strategy);
    operation = {
      operationId: status.landingOperationId ?? crypto.randomUUID(),
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      kind: strategy ? "landing" : "rebase",
      phase: strategy ? "waiting" : ready ? "rebasing" : "stalled",
      strategy,
      allowDirtyTarget: false,
      pauseReason: ready
        ? undefined
        : strategy
          ? proposing
            ? "squash-message"
            : "conflict"
          : "rebase-conflict",
    };
    yield* insert(operation);
    if (strategy) yield* run(operation, adoptLanding(operation, ready));
  }
  const snapshot: WorktreeLandingSnapshot = {};
  if (status) Object.assign(snapshot, { status });
  if (operation) Object.assign(snapshot, { operation });
  return snapshot;
});
