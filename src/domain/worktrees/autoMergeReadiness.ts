import { Effect, SubscriptionRef } from "effect";
import type { AutoMergeRequest, MergeReadiness } from "../../contracts/worktrees/auto-merge";
import { WorktreeLandingError } from "../../contracts/worktrees/worktree-landing-data";
import { CakeSessionRuntimes, type PiSessionTarget } from "../../services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";

export const setEnabled = Effect.fn("AutoMerge.setEnabled")(function* (enabled: boolean) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const storage = yield* SessionFamilyStorage;
  yield* storage.withCreationLock(
    "auto-merge-toggle",
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(coordinator.state);
      if (Boolean(current.autoMergeEnabled) === enabled) return;
      const epoch = crypto.randomUUID();
      const runId = current.autoMergeRunId ?? current.autoMergeEpoch ?? crypto.randomUUID();
      if (enabled) yield* storage.authorizeAutoMerge(runId, epoch);
      yield* SubscriptionRef.update(coordinator.state, (state) => ({
        ...state,
        autoMergeEnabled: enabled,
        autoMergeEpoch: epoch,
        autoMergeRunId: runId,
        autoMergeStatus: enabled
          ? "Merging valid ready work; waiting for validated completion"
          : "Off",
      }));
    }),
  );
});

/** A declaration is metadata for the executing turn, not a second completion report. */
export const report = Effect.fn("AutoMerge.reportReadiness")(function* (
  target: Pick<PiSessionTarget, "sessionId" | "workingDirectory" | "sessionDirectory">,
  readiness: MergeReadiness,
) {
  const storage = yield* SessionFamilyStorage;
  if (!readiness.readyToMerge) {
    yield* storage.invalidateAutoMerge(target.workingDirectory);
    return { eligible: false as const, reason: "Merge readiness was revoked." };
  }
  if (!readiness.taskCompleted || !readiness.validationPassed)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: "Finish the task and all necessary validation before declaring readiness.",
    });
  const family = yield* storage.familyForMember(target.sessionId);
  if (family && family.parentSessionId !== target.sessionId)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: "Only the family root may declare merge-and-resolve readiness.",
    });
  const ids = yield* (yield* CakeSessionRuntimes).executingTurnIds(target);
  const id = ids.length === 1 ? ids[0] : undefined;
  if (!id)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: "Readiness requires one executing task turn.",
    });
  const state = yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
  if (!state.autoMergeRunId)
    return {
      eligible: false as const,
      reason: "Readiness requires a current app-run identity.",
    };
  const document = yield* storage.state();
  const coordinatorSessionId =
    document.spawnedSessions.find((item) => item.sessionId === target.sessionId)?.requester
      .sessionId ?? document.turns.find((item) => item.turnId === id)?.senderSessionId;
  const request: AutoMergeRequest = {
    id,
    sessionId: target.sessionId,
    workspacePath: target.workingDirectory,
    epoch: state.autoMergeEpoch ?? "",
    runId: state.autoMergeRunId,
    commit: readiness.validatedCommit,
    state: "pending",
    readyToMerge: true,
  };
  if (coordinatorSessionId) Object.assign(request, { coordinatorSessionId });
  yield* storage.recordAutoMerge(request);
  const stored = (yield* storage.state()).autoMergeRequests?.find((item) => item.id === id);
  if (!stored) return { eligible: false as const, reason: "Readiness was not retained." };
  if (stored.runId !== state.autoMergeRunId)
    return { eligible: false as const, reason: "Readiness belongs to a previous app run." };
  if (
    stored.sessionId !== target.sessionId ||
    stored.workspacePath !== target.workingDirectory ||
    stored.commit !== readiness.validatedCommit
  )
    return {
      eligible: false as const,
      reason: "Stored readiness does not match this session, workspace, or validated commit.",
    };
  if (!stored.readyToMerge || (stored.state !== "pending" && stored.state !== "ready"))
    return {
      eligible: false as const,
      reason:
        stored.message ??
        `Readiness is ${stored.state}; it is not awaiting task completion or landing.`,
    };
  // The worker separately enforces toggle/epoch authorization, settlement and Git safety.
  return { eligible: true as const };
});
