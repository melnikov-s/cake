import { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import { Cause, Effect, FiberMap, Stream, SubscriptionRef } from "effect";
import type {
  WorktreeLandRequest,
  WorktreeStatus,
} from "../../contracts/worktrees/worktree-contract";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { renderCakePrompt } from "../application/cake-prompts";
import * as worktreeLifecycle from "./worktreeLifecycle";
import { resolveCakePrompts } from "../../contracts/application/cake-prompt-defaults";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingCompletion } from "../../services/worktrees/WorktreeLandingCompletion";
import {
  WorktreeLandingError,
  type WorktreeLandingOperation,
  type WorktreeLandingSnapshot,
} from "../../contracts/worktrees/worktree-landing-data";

import { measureLanding } from "../../services/diagnostics/responsiveness-diagnostics";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const normalizeOperation = (operation: WorktreeLandingOperation): WorktreeLandingOperation => {
  const normalized = { ...operation };
  if (normalized.strategy === undefined) delete normalized.strategy;
  if (normalized.resolveAfterLanding === undefined) delete normalized.resolveAfterLanding;
  if (normalized.automatic === undefined) delete normalized.automatic;
  if (normalized.autoMergeRequestId === undefined) delete normalized.autoMergeRequestId;
  if (normalized.pauseReason === undefined) delete normalized.pauseReason;
  if (normalized.error === undefined) delete normalized.error;
  if (normalized.conflictFiles === undefined) delete normalized.conflictFiles;
  if (normalized.landedCommit === undefined) delete normalized.landedCommit;
  if (normalized.cleanupFailures === undefined) delete normalized.cleanupFailures;
  if (normalized.resolvedSessionIds === undefined) delete normalized.resolvedSessionIds;
  if (normalized.resolutionError === undefined) delete normalized.resolutionError;
  return normalized;
};

/** Current-first process-lifetime projection of landing and queue progress. */
export const observeOperations = Effect.fn("WorktreeLandings.observeOperations")(function* () {
  const coordinator = yield* WorktreeLandingCoordinator;
  const worktrees = yield* ManagedWorktrees;
  return Stream.zipLatest(
    SubscriptionRef.changes(coordinator.state),
    worktrees.observeLandingQueue(),
  ).pipe(
    Stream.map(([state, waits]) => {
      const byId = new Map([...state.operations.values()].map((item) => [item.operationId, item]));
      const update = {
        operations: [...state.operations.values()].map((operation) => {
          const wait = waits.find((item) => item.operationId === operation.operationId);
          if (!wait || operation.phase !== "queued") return operation;
          const blocker = byId.get(wait.blockingOperationId);
          const queue: NonNullable<WorktreeLandingOperation["queue"]> = {
            blockingOperationId: wait.blockingOperationId,
            position: wait.position,
            queuedAt: wait.queuedAt,
          };
          if (blocker)
            Object.assign(queue, {
              blockingSessionId: blocker.sessionId,
              blockingPhase: blocker.phase,
            });
          return { ...operation, queue };
        }),
        autoMergeProjects: state.autoMergeProjects ?? [],
        autoMergeRequests: state.autoMergeRequests ?? [],
      };
      return update;
    }),
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
    return { ...state, operations };
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
  resolveCakePrompts(application.snapshot().cakePrompts);

const prompt = Effect.fn("WorktreeLandings.prompt")(function* (
  operation: WorktreeLandingOperation,
  text: string,
) {
  yield* (yield* WorktreeLandingAgent)
    .promptAndWait({ sessionId: operation.sessionId, text })
    .pipe(asError("prompt"));
});

const gitBlocked = (status: WorktreeStatus) =>
  status.dirtyCount > 0 || status.merging || status.rebasing;

const landingBlocked = (status: WorktreeStatus, strategy: WorktreeLandRequest["strategy"]) =>
  gitBlocked(status) ||
  (status.aheadCount > 0 && strategy === "squash" && !status.squashMessageReady);

/** Shared UI/tool completion. Serialize intent upgrades with terminal publication so an
 * accepted merge-and-resolve cannot miss a merge that finishes during the request. */
const completeLanding = Effect.fn("WorktreeLandings.completeLanding")(function* (
  operation: WorktreeLandingOperation,
  landedCommit?: string,
) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const worktrees = yield* ManagedWorktrees;
  const completion = yield* WorktreeLandingCompletion;
  yield* SubscriptionRef.modifyEffect(coordinator.state, (state) =>
    Effect.gen(function* () {
      const current = state.operations.get(operation.workspacePath);
      if (!current || current.operationId !== operation.operationId)
        return [undefined, state] as const;
      let completed: WorktreeLandingOperation = {
        ...current,
        phase: "landed",
        pauseReason: undefined,
        landedCommit,
        error: undefined,
        resolutionError: undefined,
      };
      if (current.resolveAfterLanding) {
        const result = yield* measureLanding(
          operation.operationId,
          "resolution-cleanup",
          completion.resolveWorkingDirectory(operation.workspacePath),
        ).pipe(Effect.result);
        if (result._tag === "Failure") {
          completed = {
            ...completed,
            phase: "failed",
            error: result.failure.message,
            resolutionError: result.failure.message,
          };
        } else {
          const resolved = result.success;
          completed = {
            ...completed,
            resolvedSessionIds: resolved.resolvedSessionIds,
            cleanupFailures: resolved.cleanupFailures.length ? resolved.cleanupFailures : undefined,
          };
          const failure = resolved.failures.length
            ? [...resolved.failures, ...resolved.cleanupFailures]
                .map((item) => item.message)
                .join("\n")
            : undefined;
          const cleared = failure
            ? undefined
            : yield* worktrees
                .setResolveAfterLanding(operation.workspacePath, false)
                .pipe(asError("resolveWorkingDirectory"), Effect.result);
          const error =
            failure ?? (cleared?._tag === "Failure" ? cleared.failure.message : undefined);
          if (error) completed = { ...completed, phase: "failed", error, resolutionError: error };
        }
      }
      // Publish resolution evidence only with the terminal phase, never before cleanup.
      const operations = new Map(state.operations);
      operations.set(operation.workspacePath, normalizeOperation(completed));
      return [undefined, { ...state, operations }] as const;
    }),
  );
});

interface AutomaticLanding {
  readonly requestId: string;
  readonly commit: string;
  readonly authorize: Effect.Effect<void, WorktreeLandingError>;
  /** Transient presentation of confirmed Git success, never snapshot/recovery delivery. */
  readonly onLanded: Effect.Effect<void>;
  /** Retires old readiness and waits for a separate, validated repair turn. Never lands. */
  readonly repair: (text: string) => Effect.Effect<void, WorktreeLandingError>;
}

const performLanding: (
  operation: WorktreeLandingOperation,
  automatic?: AutomaticLanding,
) => Effect.Effect<
  void,
  WorktreeLandingError,
  | ManagedWorktrees
  | WorktreeLandingAgent
  | WorktreeLandingCoordinator
  | WorktreeLandingCompletion
  | ApplicationState
> = Effect.fn("WorktreeLandings.performLanding")(function* (operation, automatic) {
  const worktrees = yield* ManagedWorktrees;
  const application = yield* ApplicationState;
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: "landing",
    pauseReason: undefined,
    conflictFiles: undefined,
  }));
  const request: WorktreeLandRequest = automatic
    ? { strategy: "preserve", expectedSourceCommit: automatic.commit }
    : {
        strategy: operation.strategy ?? "preserve",
        allowDirtyTarget: operation.allowDirtyTarget || undefined,
      };
  const coordinator = yield* WorktreeLandingCoordinator;
  const statusBeforeLanding = yield* requireStatus(operation.workspacePath);
  // The engine invokes authorization after queue admission, immediately before Git.
  const authorize = worktreeLifecycle
    .requireDirectMerge(statusBeforeLanding.record.projectPath)
    .pipe(
      Effect.andThen(automatic?.authorize ?? Effect.void),
      Effect.provideService(ApplicationState, application),
      Effect.mapError(
        (error) => new ManagedWorktreeError({ operation: "merge", message: error.message }),
      ),
    );
  const outcome = yield* worktrees
    .land(
      operation.workspacePath,
      operation.operationId,
      request,
      (phase) =>
        update(operation.workspacePath, operation.operationId, (current) => ({
          ...current,
          phase,
        })).pipe(Effect.provideService(WorktreeLandingCoordinator, coordinator)),
      authorize,
    )
    .pipe(asError("land"));
  if (outcome.outcome === "landed") {
    if (automatic) {
      // Retain the confirmed Git outcome even if authorization or resolution now fails.
      if (outcome.commit)
        yield* update(operation.workspacePath, operation.operationId, (current) => ({
          ...current,
          landedCommit: outcome.commit,
        }));
      yield* automatic.onLanded;
      yield* automatic.authorize;
      if (operation.resolveAfterLanding)
        yield* worktrees
          .setResolveAfterLanding(operation.workspacePath, true)
          .pipe(asError("resolveWorkingDirectory"));
    }
    return yield* completeLanding(operation, outcome.commit);
  }
  const status = yield* requireStatus(operation.workspacePath);
  const reason = outcome.outcome === "proposal" ? "squash-message" : "conflict";
  yield* update(operation.workspacePath, operation.operationId, (current) => ({
    ...current,
    phase: outcome.outcome === "proposal" ? "proposing" : "resolving",
    pauseReason: reason,
    conflictFiles: outcome.outcome === "resolving" ? outcome.files : undefined,
  }));
  if (automatic) {
    yield* automatic.repair(
      renderCakePrompt(configuredPrompts(application).worktreePreserveConflict, {
        target: status.targetBranch,
        files: outcome.outcome === "resolving" ? outcome.files : [],
      }),
    );
    yield* update(operation.workspacePath, operation.operationId, (current) => ({
      ...current,
      phase: "stalled",
      error: "Repair completed; waiting for fresh authorized readiness.",
    }));
    return;
  }
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

const reserveLanding = Effect.fn("WorktreeLandings.reserveLanding")(function* (
  operation: WorktreeLandingOperation,
) {
  const status = yield* requireStatus(operation.workspacePath);
  yield* worktreeLifecycle.requireDirectMerge(status.record.projectPath);
  yield* (yield* ManagedWorktrees)
    .prepareLanding(operation.workspacePath, operation.operationId)
    .pipe(asError("prepareLanding"));
});

const prepareCommitAndLand = Effect.fn("WorktreeLandings.prepareCommitAndLand")(function* (
  operation: WorktreeLandingOperation,
) {
  const application = yield* ApplicationState;
  yield* reserveLanding(operation);
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
  // Squash proposals are requested by land, not by the preceding commit step.
  if (gitBlocked(refreshed)) {
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
  automatic?: AutomaticLanding,
) {
  yield* reserveLanding(operation);
  yield* performLanding(operation, automatic);
});

const adoptLanding = Effect.fn("WorktreeLandings.adoptLanding")(function* (
  operation: WorktreeLandingOperation,
  ready: boolean,
) {
  yield* reserveLanding(operation);
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
    conflictFiles: undefined,
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
    conflictFiles: outcome.files,
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
          const current = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
            operation.workspacePath,
          );
          if (current?.resolveAfterLanding && record?.state !== "landed")
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
    if (
      current &&
      !isTerminal(current) &&
      !(operation.automatic && current.automatic && current.phase === "stalled")
    )
      return [false, state] as const;
    const operations = new Map(state.operations);
    operations.set(operation.workspacePath, normalizeOperation(operation));
    return [true, { ...state, operations }] as const;
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
  readonly automatic?: AutomaticLanding;
}) {
  const status = yield* requireStatus(input.workspacePath);
  yield* worktreeLifecycle.requireDirectMerge(status.record.projectPath);
  const operation = normalizeOperation({
    operationId: input.operationId,
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    kind: "landing",
    phase: "waiting",
    strategy: input.strategy,
    allowDirtyTarget: input.allowDirtyTarget,
    resolveAfterLanding: input.resolveAfterLanding || undefined,
    automatic: input.automatic ? true : undefined,
    autoMergeRequestId: input.automatic?.requestId,
  });
  yield* insert(operation);
  yield* run(
    operation,
    Effect.gen(function* () {
      if (input.resolveAfterLanding && !input.automatic)
        yield* (yield* ManagedWorktrees)
          .setResolveAfterLanding(input.workspacePath, true)
          .pipe(asError("start"));
      yield* input.commitBeforeLanding
        ? prepareCommitAndLand(operation)
        : prepareAndLand(operation, input.automatic);
    }),
  );
  return operation;
});

/** Start/join the same landing workflow as UI Merge & resolve. The coordinator's
 * existing state lock owns duplicate admission and resolve-intent upgrades. */
export const mergeAndResolve = Effect.fn("WorktreeLandings.mergeAndResolve")(function* (input: {
  readonly workspacePath: string;
  readonly sessionId: string;
}) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const worktrees = yield* ManagedWorktrees;
  const claimed = yield* SubscriptionRef.modifyEffect(coordinator.state, (state) =>
    Effect.gen(function* () {
      const current = state.operations.get(input.workspacePath);
      if (current && !isTerminal(current) && current.kind !== "landing")
        return yield* new WorktreeLandingError({
          operation: "mergeAndResolve",
          message: "A rebase is already in progress for this worktree.",
        });
      const record = (yield* worktrees.records().pipe(asError("mergeAndResolve"))).find(
        (item) => item.worktreePath === input.workspacePath,
      );
      const status = yield* worktrees.status(input.workspacePath).pipe(asError("mergeAndResolve"));
      const alreadyLanded =
        (record?.state === "landed" ||
          (record?.state === "resolved" && record.resolvedFrom === "landed")) &&
        (!status || (!gitBlocked(status) && status.aheadCount === 0));
      if (record) yield* worktreeLifecycle.requireDirectMerge(record.projectPath);
      if (
        alreadyLanded &&
        current?.phase === "landed" &&
        current.resolveAfterLanding &&
        current.resolvedSessionIds !== undefined
      )
        return [{ operation: current, start: false, alreadyLanded }, state] as const;
      if (!record)
        return yield* new WorktreeLandingError({
          operation: "mergeAndResolve",
          message: "Cake could not find that worktree",
        });
      yield* worktrees
        .setResolveAfterLanding(input.workspacePath, true)
        .pipe(asError("mergeAndResolve"));
      const joining = current && !isTerminal(current);
      const operation = normalizeOperation(
        joining
          ? { ...current, resolveAfterLanding: true }
          : {
              operationId: crypto.randomUUID(),
              workspacePath: input.workspacePath,
              sessionId: input.sessionId,
              kind: "landing",
              phase: "waiting",
              strategy: "preserve",
              allowDirtyTarget: false,
              resolveAfterLanding: true,
            },
      );
      const operations = new Map(state.operations);
      operations.set(input.workspacePath, operation);
      return [
        { operation, start: !joining, alreadyLanded },
        { ...state, operations },
      ] as const;
    }),
  );
  if (claimed.start)
    yield* run(
      claimed.operation,
      claimed.alreadyLanded
        ? completeLanding(claimed.operation)
        : prepareCommitAndLand(claimed.operation),
    );
  return claimed.operation;
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
  const current = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
    input.workspacePath,
  );
  if (current?.kind === "landing")
    yield* worktreeLifecycle.requireDirectMerge(status.record.projectPath);
  if (current?.automatic)
    return yield* new WorktreeLandingError({
      operation: "retry",
      message:
        "Automatic repair requires fresh commit-bound readiness and current Auto-merge authorization.",
    });
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
    return [claimed, { ...state, operations }] as const;
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
            if (gitBlocked(refreshed)) {
              yield* update(operation.workspacePath, operation.operationId, (item) => ({
                ...item,
                phase: "stalled",
              }));
              return;
            }
            yield* performLanding(operation);
          })
        : Effect.gen(function* () {
            // Retry Git first so resolved conflicts resume landing and any remaining
            // conflicts are prompted with the engine's current file list.
            if (
              operation.pauseReason !== "squash-message" ||
              !landingBlocked(status, operation.strategy ?? "preserve")
            )
              return yield* performLanding(operation);
            yield* update(operation.workspacePath, operation.operationId, (item) => ({
              ...item,
              phase: "proposing",
            }));
            yield* prompt(
              operation,
              renderCakePrompt(configuredPrompts(application).worktreeSquashMessage, {
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
    return { ...state, operations };
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
  if (current.phase !== "waiting" && current.phase !== "queued" && current.phase !== "stalled")
    return yield* new WorktreeLandingError({
      operation: "cancel",
      message: "This merge has already started and can no longer be canceled.",
    });
  const worktrees = yield* ManagedWorktrees;
  if (current.kind === "landing" && (current.phase === "waiting" || current.phase === "queued")) {
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
    return { ...state, operations };
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
  const existing = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
    input.workspacePath,
  );
  let status = yield* worktrees.status(input.workspacePath).pipe(asError("inspect"));
  if (
    durableRecord?.state === "landed" &&
    durableRecord.resolveAfterLanding &&
    (!existing || isTerminal(existing)) &&
    (!status || (!gitBlocked(status) && status.aheadCount === 0))
  ) {
    const result = yield* (yield* WorktreeLandingCompletion).resolveWorkingDirectory(
      input.workspacePath,
    );
    if (result.failures.length > 0)
      return yield* new WorktreeLandingError({
        operation: "resolveWorkingDirectory",
        message: [...result.failures, ...result.cleanupFailures]
          .map((failure) => failure.message)
          .join("\n"),
      });
    yield* worktrees
      .setResolveAfterLanding(input.workspacePath, false)
      .pipe(asError("resolveWorkingDirectory"));
    // Recovery of a landed resolve intent completes resolution only, never Git landing.
    const current = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
      input.workspacePath,
    );
    const completed = normalizeOperation({
      operationId: current?.operationId ?? crypto.randomUUID(),
      workspacePath: input.workspacePath,
      sessionId: current?.sessionId ?? input.sessionId,
      kind: "landing",
      phase: "landed",
      allowDirtyTarget: current?.allowDirtyTarget ?? false,
      resolveAfterLanding: true,
      resolvedSessionIds: result.resolvedSessionIds,
      cleanupFailures: result.cleanupFailures.length > 0 ? result.cleanupFailures : undefined,
    });
    if (current) yield* update(input.workspacePath, current.operationId, () => completed);
    else if (result.cleanupFailures.length > 0) yield* insert(completed);
    status = yield* worktrees.status(input.workspacePath).pipe(asError("inspect"));
  }
  let operation = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
    input.workspacePath,
  );
  if (
    !operation &&
    status &&
    (status.record.pendingStrategy || status.rebasing) &&
    (!status.record.pendingStrategy ||
      !(yield* worktreeLifecycle.forProject(status.record.projectPath)).landsThroughPullRequests)
  ) {
    const strategy = status.record.pendingStrategy;
    const proposing = strategy === "squash" && !status.merging && !status.rebasing;
    const ready = strategy !== undefined && !landingBlocked(status, strategy);
    operation = normalizeOperation({
      operationId: status.landingOperationId ?? crypto.randomUUID(),
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      kind: strategy ? "landing" : "rebase",
      phase: status.record.pendingAutomaticLanding
        ? "stalled"
        : strategy
          ? "waiting"
          : ready
            ? "rebasing"
            : "stalled",
      automatic: status.record.pendingAutomaticLanding ? true : undefined,
      strategy,
      allowDirtyTarget: false,
      resolveAfterLanding: status.record.resolveAfterLanding,
      pauseReason: ready
        ? undefined
        : strategy
          ? proposing
            ? "squash-message"
            : "conflict"
          : "rebase-conflict",
    });
    yield* insert(operation);
    if (strategy && !operation.automatic) yield* run(operation, adoptLanding(operation, ready));
  }
  const snapshot: WorktreeLandingSnapshot = {};
  if (status) Object.assign(snapshot, { status });
  if (operation) Object.assign(snapshot, { operation });
  return snapshot;
});
