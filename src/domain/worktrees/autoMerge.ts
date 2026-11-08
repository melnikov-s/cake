import { Effect, SubscriptionRef } from "effect";
import { WorktreeLandingError } from "../../contracts/worktrees/worktree-landing-data";
import type { AutoMergeOutcome, AutoMergeRequest } from "../../contracts/worktrees/auto-merge";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import * as landings from "./worktreeLandings";

const emptyRequests: ReadonlyArray<AutoMergeRequest> = [];

/** Single worker pass. The existing engine owns the repository FIFO and Git safety. */
export const runPass = Effect.fn("AutoMerge.runPass")(function* () {
  const storage = yield* SessionFamilyStorage;
  const coordinator = yield* WorktreeLandingCoordinator;
  const worktrees = yield* ManagedWorktrees;
  const sessions = yield* CakeSessionRuntimes;
  const requests = (yield* storage.state()).autoMergeRequests ?? emptyRequests;
  yield* SubscriptionRef.update(coordinator.state, (state) =>
    state.autoMergeRequests === requests ? state : { ...state, autoMergeRequests: requests },
  );
  const finish = Effect.fn("AutoMerge.finish")(function* (
    request: AutoMergeRequest,
    state: AutoMergeRequest["state"],
    message: string,
  ) {
    let outcome: AutoMergeOutcome | undefined;
    if (state === "landed" || state === "failed") {
      const record = (yield* worktrees.records()).find(
        (item) => item.worktreePath === request.workspacePath,
      );
      const operation = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
        request.workspacePath,
      );
      const matchingOperation =
        operation?.operationId ===
        (request.attempt ? `${request.id}:${request.attempt}` : request.id)
          ? operation
          : undefined;
      const confirmedRecord =
        record?.resolveAfterLanding ||
        (record?.state === "resolved" && record.resolvedFrom === "landed");
      const landedCommit =
        matchingOperation?.landedCommit ??
        (confirmedRecord ? record?.landedSourceCommit : undefined);
      const merged =
        state === "landed" || Boolean(matchingOperation?.landedCommit) || Boolean(confirmedRecord);
      outcome = {
        targetBranch: record?.baseBranch ?? "unknown",
        merged,
        resolutionSucceeded: state === "landed",
        message,
      };
      if (landedCommit) Object.assign(outcome, { landedCommit });
    }
    yield* storage.updateAutoMerge(request.id, state, message, outcome);
    yield* SubscriptionRef.update(coordinator.state, (current) => ({
      ...current,
      autoMergeStatus: message,
    }));
  });
  for (const request of requests) {
    if (request.state !== "ready" && request.state !== "landing" && request.state !== "pending")
      continue;
    const operationId = request.attempt ? `${request.id}:${request.attempt}` : request.id;
    const current = yield* SubscriptionRef.get(coordinator.state);
    const operation = current.operations.get(request.workspacePath);
    if (request.state === "landing") {
      if (operation?.operationId === operationId) {
        if (operation.phase === "landed") {
          const resolved = operation.resolvedSessionIds?.includes(request.sessionId) === true;
          yield* finish(
            request,
            resolved ? "landed" : "failed",
            resolved
              ? operation.cleanupFailures?.length
                ? `Auto-merged and resolved; cleanup needs attention: ${operation.cleanupFailures.map((failure) => failure.message).join("; ")}`
                : "Auto-merged and resolved"
              : "Merged, but session resolution was not confirmed",
          );
        } else if (operation.phase === "failed" || operation.phase === "stalled") {
          yield* finish(
            request,
            "failed",
            operation.error ?? "Auto-merge blocked; session remains unresolved",
          );
        }
        continue;
      }
      // Never replay a Git attempt after restart or an acknowledged projection. Only a
      // durable successful landing + committed resolution intent may recover resolution.
      const record = (yield* worktrees.records()).find(
        (item) => item.worktreePath === request.workspacePath,
      );
      if (record?.state === "resolved" && record.resolvedFrom === "landed") {
        yield* finish(request, "landed", "Auto-merged and resolved");
      } else if (record?.state === "landed" && record.resolveAfterLanding) {
        const recovered = yield* landings
          .inspect({ workspacePath: request.workspacePath, sessionId: request.sessionId })
          .pipe(Effect.result);
        if (recovered._tag === "Failure")
          yield* finish(
            request,
            "failed",
            `Merged; resolution recovery failed: ${recovered.failure.message}`,
          );
        else {
          const after = (yield* worktrees.records()).find(
            (item) => item.worktreePath === request.workspacePath,
          );
          yield* finish(
            request,
            after?.state === "resolved" ? "landed" : "failed",
            after?.state === "resolved"
              ? "Auto-merged and resolved"
              : "Merged; resolution could not be confirmed",
          );
        }
      } else {
        yield* finish(
          request,
          "failed",
          "Auto-merge interrupted; inspect the managed worktree before retrying. No landing was replayed.",
        );
      }
      continue;
    }
    if (request.runId !== current.autoMergeRunId) {
      yield* storage.invalidateAutoMerge(request.workspacePath, request.id);
      continue;
    }
    if (request.state === "pending" || !current.autoMergeEnabled) continue;
    if (current.autoMergeEpoch !== request.epoch) {
      yield* finish(
        request,
        "canceled",
        "Auto-merge authorization expired; fresh validated completion required",
      );
      continue;
    }
    // Preserve normal completion delivery before retiring its source checkout.
    if ((yield* storage.state()).turns.some((turn) => turn.turnId === request.id && !turn.reported))
      continue;
    if ((yield* sessions.activeWorkingDirectories()).includes(request.workspacePath)) continue;
    // Admit one automatic landing at a time. Manual operations retain engine FIFO order.
    if (
      [...current.operations.values()].some(
        (item) => !["landed", "complete", "failed", "stalled"].includes(item.phase),
      )
    )
      continue;
    const authorize = Effect.gen(function* () {
      const authorization = yield* SubscriptionRef.get(coordinator.state);
      const latest = (yield* storage.state()).autoMergeRequests?.find(
        (item) => item.id === request.id,
      );
      if (
        !authorization.autoMergeEnabled ||
        authorization.autoMergeEpoch !== request.epoch ||
        latest?.state !== "landing" ||
        (yield* sessions.activeWorkingDirectories()).includes(request.workspacePath)
      )
        return yield* new WorktreeLandingError({
          operation: "autoMerge",
          message: "Auto-merge was disabled or readiness became stale; session remains unresolved",
        });
    }).pipe(
      Effect.mapError(
        (error) => new WorktreeLandingError({ operation: "autoMerge", message: error.message }),
      ),
    );
    if (operation?.phase === "stalled") {
      const previous = requests.find(
        (item) =>
          item.id === operation.operationId || operation.operationId.startsWith(`${item.id}:`),
      );
      if (!previous) {
        yield* finish(request, "failed", "A manual landing is stalled; finish or cancel it first");
        continue;
      }
      yield* landings.cancel(request.workspacePath, operation.operationId);
    }
    yield* storage.updateAutoMerge(request.id, "landing");
    yield* landings
      .start({
        operationId,
        workspacePath: request.workspacePath,
        sessionId: request.sessionId,
        strategy: "preserve",
        allowDirtyTarget: false,
        commitBeforeLanding: false,
        resolveAfterLanding: true,
        automatic: { commit: request.commit, authorize },
      })
      .pipe(Effect.catch((error) => finish(request, "failed", error.message)));
    // Read the next request only after the launched operation is observed on a later pass.
    return;
  }
});
