import { Effect, SubscriptionRef } from "effect";
import type { AutoMergeRequest, MergeReadiness } from "../../contracts/worktrees/auto-merge";
import { WorktreeLandingError } from "../../contracts/worktrees/worktree-landing-data";
import { CakeSessionRuntimes, type PiSessionTarget } from "../../services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import * as worktreeLifecycle from "./worktreeLifecycle";

/** Restore only the preference, after ApplicationState hydration and before workers/endpoints.
 * Run identity and epochs stay fresh: no previous-run readiness is authorized here.
 */
export const initialize = Effect.fn("AutoMerge.initialize")(function* () {
  const projects = (yield* ApplicationState).snapshot().projects;
  const coordinator = yield* WorktreeLandingCoordinator;
  yield* SubscriptionRef.update(coordinator.state, (state) => ({
    ...state,
    autoMergeProjects: projects.map((project) => ({
      projectPath: project.path,
      enabled: project.autoMergeEnabled ?? false,
      epoch: crypto.randomUUID(),
      status: project.autoMergeEnabled
        ? "Merging validated work directly delegated by this project’s Project Chat"
        : "Off",
    })),
  }));
});

export const setEnabled = Effect.fn("AutoMerge.setEnabled")(function* (
  projectPath: string,
  enabled: boolean,
) {
  const application = yield* ApplicationState;
  if (!application.snapshot().projects.some((project) => project.path === projectPath))
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
      // Commit the project preference before publishing success to any window. Once
      // persistence starts, finish publication together with it, even on interruption.
      yield* Effect.gen(function* () {
        yield* application.transact((state) =>
          Effect.succeed({
            ...state,
            projects: state.projects.map((project) =>
              project.path === projectPath ? { ...project, autoMergeEnabled: enabled } : project,
            ),
          }),
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
      }).pipe(Effect.uninterruptible);
    }),
  );
});

const listed = (files: ReadonlyArray<string>) =>
  `${files.slice(0, 5).join(", ")}${files.length > 5 ? ` and ${files.length - 5} more` : ""}`;

/** Why the checkout cannot be declared ready as-is, or its HEAD. A supplied commit (full or
 * prefix) is only an assertion: Cake always records the checkout's actual HEAD. */
export const inspectReadyHead = Effect.fn("AutoMerge.inspectReadyHead")(function* (
  workspacePath: string,
  asserted?: string,
) {
  const state = yield* (yield* ManagedWorktrees)
    .headState(workspacePath)
    .pipe(
      Effect.mapError(
        (error) => new WorktreeLandingError({ operation: "readiness", message: error.message }),
      ),
    );
  if (!state)
    return { problem: "The managed worktree is unavailable; readiness needs its checkout." };
  if (state.rebasing || state.merging)
    return {
      head: state.head,
      problem: `A ${state.rebasing ? "rebase" : "merge"} is still in progress. Resolve, stage and continue it until Git finishes, then report readiness.`,
    };
  if (state.changedFiles.length)
    return {
      head: state.head,
      problem: `The worktree has ${state.changedFiles.length} uncommitted or untracked file(s): ${listed(state.changedFiles)}. Commit or discard them first, then report readiness.`,
    };
  if (asserted && !state.head.startsWith(asserted.toLowerCase()))
    return {
      head: state.head,
      problem: `HEAD is ${state.head}; you passed ${asserted}. Omit validatedCommit to declare the current HEAD, or commit the validated work first.`,
    };
  return { head: state.head };
});

/** A declaration is metadata for the executing turn, not a second completion report. */
export const report = Effect.fn("AutoMerge.reportReadiness")(function* (
  target: Pick<PiSessionTarget, "sessionId" | "workingDirectory" | "sessionDirectory">,
  readiness: MergeReadiness,
) {
  const storage = yield* SessionFamilyStorage;
  if (!readiness.readyToMerge) {
    yield* storage.invalidateAutoMerge(
      target.workingDirectory,
      undefined,
      "The session revoked merge readiness",
    );
    return { eligible: false as const, reason: "Merge readiness was revoked." };
  }
  const record = (yield* (yield* ManagedWorktrees).records()).find(
    (item) => item.worktreePath === target.workingDirectory,
  );
  if (!record)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: "Merge readiness requires a Cake-managed worktree.",
    });
  yield* worktreeLifecycle.requireDirectMerge(record.projectPath);
  if (!readiness.taskCompleted || !readiness.validationPassed)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: "Finish the task and all necessary validation before declaring readiness.",
    });
  // Fail at call time instead of accepting a declaration that landing would later reject.
  const inspected = yield* inspectReadyHead(target.workingDirectory, readiness.validatedCommit);
  if (inspected.problem !== undefined || !inspected.head)
    return yield* new WorktreeLandingError({
      operation: "readiness",
      message: inspected.problem ?? "Cake could not read the worktree HEAD.",
    });
  const head = inspected.head;
  const projectPath = record.projectPath;
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
    commit: head,
    state: "pending",
    message: "Waiting for task completion",
    readyToMerge: true,
  };
  if (coordinatorSessionId) Object.assign(request, { coordinatorSessionId });
  const operation = state.operations.get(target.workingDirectory);
  if (
    operation?.automatic &&
    !operation.cancellationRequested &&
    operation.sessionId === target.sessionId &&
    (operation.phase === "resolving" ||
      operation.phase === "validating" ||
      operation.phase === "stalled")
  ) {
    const previous = document.autoMergeRequests?.find(
      (item) => item.id === operation.autoMergeRequestId,
    );
    if (previous)
      Object.assign(request, {
        repairAttempt: (previous.repairAttempt ?? 0) + 1,
        repairOfRequestId: previous.id,
      });
  }
  yield* storage.recordAutoMerge(request);
  const stored = (yield* storage.state()).autoMergeRequests?.find((item) => item.id === id);
  if (!stored) return { eligible: false as const, reason: "Readiness was not retained." };
  if (stored.runId !== state.autoMergeRunId)
    return { eligible: false as const, reason: "Readiness belongs to a previous app run." };
  if (
    stored.sessionId !== target.sessionId ||
    stored.workspacePath !== target.workingDirectory ||
    stored.projectPath !== projectPath
  )
    return {
      eligible: false as const,
      reason: "Stored readiness does not match this session or workspace.",
    };
  if (stored.commit !== head)
    return {
      eligible: false as const,
      reason: `This run already declared readiness for ${stored.commit}, but HEAD is now ${head}. A run's declaration is not replaced; landing will reject the earlier commit as stale.`,
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
