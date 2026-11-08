import { Effect, SubscriptionRef } from "effect";
import type { AutoMergeRequest, MergeReadiness } from "../../contracts/worktrees/auto-merge";
import { WorktreeLandingError } from "../../contracts/worktrees/worktree-landing-data";
import { CakeSessionRuntimes, type PiSessionTarget } from "../../services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";

export const setEnabled = Effect.fn("AutoMerge.setEnabled")(function* (
  projectPath: string,
  enabled: boolean,
) {
  if (
    !(yield* ApplicationState).snapshot().projects.some((project) => project.path === projectPath)
  )
    return yield* new WorktreeLandingError({
      operation: "setAutoMerge",
      message:
        "Auto-merge requires an exact registered project root; no global authorization exists.",
    });
  const coordinator = yield* WorktreeLandingCoordinator;
  const storage = yield* SessionFamilyStorage;
  yield* storage.withCreationLock(
    `auto-merge-toggle:${projectPath}`,
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(coordinator.state);
      const previous = current.autoMergeProjects?.find((item) => item.projectPath === projectPath);
      if (Boolean(previous?.enabled) === enabled) return;
      const epoch = crypto.randomUUID();
      const runId = current.autoMergeRunId ?? crypto.randomUUID();
      if (enabled)
        yield* storage.authorizeAutoMerge(
          runId,
          epoch,
          projectPath,
          projectChatSessionId(projectPath),
        );
      yield* SubscriptionRef.update(coordinator.state, (state) => ({
        ...state,
        autoMergeRunId: runId,
        autoMergeProjects: [
          ...(state.autoMergeProjects ?? []).filter((item) => item.projectPath !== projectPath),
          {
            projectPath,
            enabled,
            epoch,
            status: enabled
              ? "Merging validated work directly delegated by this project’s Project Chat"
              : "Off",
          },
        ],
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
  const record = (yield* (yield* ManagedWorktrees).records()).find(
    (item) => item.worktreePath === target.workingDirectory,
  );
  const projectPath = record?.projectPath;
  if (
    !projectPath ||
    !(yield* ApplicationState).snapshot().projects.some((item) => item.path === projectPath)
  )
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: `No registered owning project for managed workspace ${target.workingDirectory}.`,
    });
  const family = yield* storage.familyForMember(target.sessionId);
  if (family && family.parentSessionId !== target.sessionId)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: "Only the family root may declare merge-and-resolve readiness.",
    });
  const ids = yield* (yield* CakeSessionRuntimes).executingTurnIds(target);
  // Pi consumes steering and coordination inputs into one run. The oldest accepted
  // consumed input anchors that run; the rest are not competing task executions.
  const id = ids[0];
  if (!id)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: `Readiness requires an executing task run for session ${target.sessionId}; executing input count=${ids.length}, ids=${JSON.stringify(ids)}.`,
    });
  const state = yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
  if (!state.autoMergeRunId)
    return {
      eligible: false as const,
      reason: "Readiness requires a current app-run identity.",
    };
  const document = yield* storage.state();
  const foreignTurns = document.turns.filter(
    (turn) => ids.includes(turn.turnId) && turn.sessionId !== target.sessionId,
  );
  if (foreignTurns.length)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: `Executing inputs do not belong to session ${target.sessionId}; count=${ids.length}, ids=${JSON.stringify(ids)}, foreign ids=${JSON.stringify(foreignTurns.map((turn) => turn.turnId))}.`,
    });
  const coordinatorSessionId =
    document.spawnedSessions.find((item) => item.sessionId === target.sessionId)?.requester
      .sessionId ?? document.turns.find((item) => item.turnId === id)?.senderSessionId;
  const request: AutoMergeRequest = {
    id,
    sessionId: target.sessionId,
    workspacePath: target.workingDirectory,
    projectPath,
    epoch: state.autoMergeProjects?.find((item) => item.projectPath === projectPath)?.epoch ?? "",
    runId: state.autoMergeRunId,
    commit: readiness.validatedCommit,
    state: "pending",
    message: "Waiting for task completion",
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
    stored.projectPath !== projectPath ||
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
