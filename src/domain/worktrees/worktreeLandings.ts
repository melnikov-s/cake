import { Cause, Effect, FiberMap, Stream, SubscriptionRef } from "effect";
import type { WorktreeLandRequest, WorktreeStatus } from "../../ipc/worktree-contract";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { renderCakePrompt } from "../application/cake-prompts";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingCompletion } from "../../services/worktrees/WorktreeLandingCompletion";
import {
  WorktreeLandingError,
  type WorktreeLandingOperation,
  type WorktreeLandingSnapshot,
} from "./worktree-landing-data";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const normalizeOperation = (operation: WorktreeLandingOperation): WorktreeLandingOperation => {
  const normalized = { ...operation };
  if (normalized.strategy === undefined) delete normalized.strategy;
  if (normalized.resolveAfterLanding === undefined) delete normalized.resolveAfterLanding;
  if (normalized.pauseReason === undefined) delete normalized.pauseReason;
  if (normalized.error === undefined) delete normalized.error;
  return normalized;
};

/** Current-first process-lifetime projection of landing and queue progress. */
export const observeOperations = Effect.fn("WorktreeLandings.observeOperations")(function* () {
  const coordinator = yield* WorktreeLandingCoordinator;
  return SubscriptionRef.changes(coordinator.state).pipe(
    Stream.map((state) => ({ operations: [...state.operations.values()] })),
  );
});
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
    operations.set(workspacePath, normalizeOperation(change(current)));
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

const configuredPrompts = (application: ApplicationState["Service"]) =>
  application.snapshot().cakePrompts;

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
  | ManagedWorktrees
  | WorktreeLandingAgent
  | WorktreeLandingCoordinator
  | WorktreeLandingCompletion
  | ApplicationState
> = Effect.fn("WorktreeLandings.performLanding")(function* (operation) {
  const worktrees = yield* ManagedWorktrees;
  const application = yield* ApplicationState;
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
    if (operation.resolveAfterLanding) {
      const result = yield* (yield* WorktreeLandingCompletion).resolveWorkingDirectory(
        operation.workspacePath,
      );
      if (result.failures.length > 0)
        return yield* new WorktreeLandingError({
          operation: "resolveWorkingDirectory",
          message: result.failures.map((failure) => failure.message).join("\n"),
        });
      yield* worktrees
        .setResolveAfterLanding(operation.workspacePath, false)
        .pipe(asError("resolveWorkingDirectory"));
    }
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
      ? renderCakePrompt(configuredPrompts(application).worktreeSquashMessage, {
          target: status.targetBranch,
        })
      : renderCakePrompt(
          request.strategy === "squash"
            ? configuredPrompts(application).worktreeSquashConflict
            : configuredPrompts(application).worktreePreserveConflict,
          { target: status.targetBranch, files: outcome.files },
        ),
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
  const application = yield* ApplicationState;
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
  yield* prompt(
    operation,
    renderCakePrompt(configuredPrompts(application).worktreeCommit, {
      target: status.targetBranch,
    }),
  );
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
  const application = yield* ApplicationState;
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
  yield* prompt(
    operation,
    renderCakePrompt(configuredPrompts(application).worktreeRebaseConflict, {
      target: status.targetBranch,
      files: outcome.files,
    }),
  );
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
    | ManagedWorktrees
    | WorktreeLandingAgent
    | WorktreeLandingCoordinator
    | WorktreeLandingCompletion
    | ApplicationState
  >,
) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const supervised = worker.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (operation.kind === "landing") {
          const worktrees = yield* ManagedWorktrees;
          yield* worktrees
            .cancelLanding(operation.workspacePath, operation.operationId)
            .pipe(Effect.ignore);
          const record = (yield* worktrees
            .records()
            .pipe(Effect.catch(() => Effect.succeed([])))).find(
            (candidate) => candidate.worktreePath === operation.workspacePath,
          );
          if (operation.resolveAfterLanding && record?.state !== "landed")
            yield* worktrees
              .setResolveAfterLanding(operation.workspacePath, false)
              .pipe(Effect.ignore);
        }
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
    operations.set(operation.workspacePath, normalizeOperation(operation));
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
  readonly resolveAfterLanding?: boolean;
}) {
  yield* requireStatus(input.workspacePath);
  const operation = normalizeOperation({
    operationId: input.operationId,
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    kind: "landing",
    phase: "waiting",
    strategy: input.strategy,
    allowDirtyTarget: input.allowDirtyTarget,
    resolveAfterLanding: input.resolveAfterLanding || undefined,
  });
  yield* insert(operation);
  if (input.resolveAfterLanding)
    yield* (yield* ManagedWorktrees)
      .setResolveAfterLanding(input.workspacePath, true)
      .pipe(asError("start"));
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
  const application = yield* ApplicationState;
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
    const claimed = normalizeOperation({
      ...current,
      sessionId: input.sessionId,
      phase: retryPhase,
      error: undefined,
    });
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
            yield* prompt(
              operation,
              renderCakePrompt(configuredPrompts(application).worktreeCommit, {
                target: status.targetBranch,
              }),
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
          })
        : Effect.gen(function* () {
            const reason = operation.pauseReason ?? "conflict";
            yield* update(operation.workspacePath, operation.operationId, (item) => ({
              ...item,
              phase: reason === "squash-message" ? "proposing" : "resolving",
            }));
            yield* prompt(
              operation,
              renderCakePrompt(
                reason === "squash-message"
                  ? configuredPrompts(application).worktreeSquashMessage
                  : operation.strategy === "squash"
                    ? configuredPrompts(application).worktreeSquashConflict
                    : configuredPrompts(application).worktreePreserveConflict,
                { target: status.targetBranch, files: [] },
              ),
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

export const acknowledge = Effect.fn("WorktreeLandings.acknowledge")(function* (
  workspacePath: string,
  operationId: string,
) {
  const coordinator = yield* WorktreeLandingCoordinator;
  yield* SubscriptionRef.update(coordinator.state, (state) => {
    const current = state.operations.get(workspacePath);
    if (!current || current.operationId !== operationId || !isTerminal(current)) return state;
    const operations = new Map(state.operations);
    operations.delete(workspacePath);
    return { operations };
  });
});

export const cancel = Effect.fn("WorktreeLandings.cancel")(function* (
  workspacePath: string,
  operationId: string,
) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const current = (yield* SubscriptionRef.get(coordinator.state)).operations.get(workspacePath);
  // A delayed renderer request must never cancel a newer operation for the same worktree.
  if (!current || current.operationId !== operationId) return;
  if (current.phase !== "waiting" && current.phase !== "stalled")
    return yield* new WorktreeLandingError({
      operation: "cancel",
      message: "This merge has already started and can no longer be canceled.",
    });
  const worktrees = yield* ManagedWorktrees;
  if (current.kind === "landing" && current.phase === "waiting") {
    // The engine owns the FIFO and must atomically prove that this entry is
    // still pending. A status check here would race with queue promotion.
    yield* worktrees
      .cancelLanding(workspacePath, current.operationId, true)
      .pipe(asError("cancel"));
    yield* FiberMap.remove(coordinator.fibers, workspacePath);
  } else {
    yield* FiberMap.remove(coordinator.fibers, workspacePath);
    if (current.kind === "landing")
      yield* worktrees.cancelLanding(workspacePath, current.operationId).pipe(asError("cancel"));
  }
  if (current.resolveAfterLanding)
    yield* worktrees.setResolveAfterLanding(workspacePath, false).pipe(asError("cancel"));
  yield* SubscriptionRef.update(coordinator.state, (state) => {
    const latest = state.operations.get(workspacePath);
    if (!latest || latest.operationId !== operationId) return state;
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
  const durableRecord = (yield* worktrees.records().pipe(asError("inspect"))).find(
    (record) => record.worktreePath === input.workspacePath,
  );
  if (durableRecord?.state === "landed" && durableRecord.resolveAfterLanding) {
    const result = yield* (yield* WorktreeLandingCompletion).resolveWorkingDirectory(
      input.workspacePath,
    );
    if (result.failures.length > 0)
      return yield* new WorktreeLandingError({
        operation: "resolveWorkingDirectory",
        message: result.failures.map((failure) => failure.message).join("\n"),
      });
    yield* worktrees
      .setResolveAfterLanding(input.workspacePath, false)
      .pipe(asError("resolveWorkingDirectory"));
  }
  const status = yield* worktrees.status(input.workspacePath).pipe(asError("inspect"));
  let operation = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
    input.workspacePath,
  );
  if (!operation && status && (status.record.pendingStrategy || status.rebasing)) {
    const strategy = status.record.pendingStrategy;
    const proposing = strategy === "squash" && !status.merging && !status.rebasing;
    const ready = strategy !== undefined && !landingBlocked(status, strategy);
    operation = normalizeOperation({
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
    });
    yield* insert(operation);
    if (strategy) yield* run(operation, adoptLanding(operation, ready));
  }
  const snapshot: WorktreeLandingSnapshot = {};
  if (status) Object.assign(snapshot, { status });
  if (operation) Object.assign(snapshot, { operation });
  return snapshot;
});
