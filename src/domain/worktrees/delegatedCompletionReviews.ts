import { Clock, Effect, SubscriptionRef } from "effect";
import type { ApplicationState as ApplicationStateValue } from "../../contracts/application/application-data";
import {
  NOTICE_DELIVERY_MAX_FAILURES,
  type SessionFamilyDocument,
  type SessionRelationship,
} from "../../contracts/session-families/session-family-document";
import type { AutoMergeRequest } from "../../contracts/worktrees/auto-merge";
import { isDirectProjectChatDelegation } from "../../contracts/worktrees/auto-merge-delegation";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  WorktreeLandingCoordinator,
  type WorktreeLandingCoordinatorState,
} from "../../services/worktrees/WorktreeLandingCoordinator";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import { reviewDelegatedResult } from "../projects/projectTodos";

// Give ordinary delivery, composer presence and landing admission room to settle. Exhausted
// delivery retries, unlike a brief handoff, are already actionable without a clock threshold.
const HANDOFF_GRACE_MS = 60_000;

const landingState = Effect.fn("DelegatedCompletionReviews.landingState")(function* () {
  return yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
});

const hasSettled = (request: AutoMergeRequest) =>
  request.settledAt !== undefined ||
  request.state === "ready" ||
  request.state === "landing" ||
  request.state === "landed" ||
  (request.state === "failed" && (request.readyToMerge || request.outcome));

function decision(
  owner: SessionRelationship,
  document: SessionFamilyDocument,
  requests: readonly AutoMergeRequest[],
  application: ApplicationStateValue,
  landing: WorktreeLandingCoordinatorState,
  now: number,
) {
  const { sessionId, projectPath, taskCompletion } = owner;
  if (owner.purpose !== "delegated") return;
  const project = application.projects.find((item) => item.path === projectPath);
  if (!project) return;
  if (taskCompletion)
    return {
      id: `delegated-completion:${taskCompletion.turnId}`,
      workspacePath: taskCompletion.workspacePath,
      settledAt: taskCompletion.settledAt,
      reason:
        "Review the completed delegated result and decide whether to resolve the task or continue it.",
    };
  const latest = requests.at(-1);
  if (!latest || latest.projectPath !== projectPath) return;
  // Repair is part of the same decision. If its turn stopped before declaring fresh readiness,
  // the settled predecessor can still have a terminal failure that needs review.
  let request = latest;
  let root = latest;
  while (root.repairOfRequestId !== undefined) {
    const previous = requests.find((item) => item.id === root.repairOfRequestId);
    if (
      !previous ||
      previous.projectPath !== root.projectPath ||
      previous.workspacePath !== root.workspacePath ||
      previous.runId !== root.runId ||
      (previous.repairAttempt ?? 0) + 1 !== root.repairAttempt
    )
      break;
    root = previous;
    if (!hasSettled(request)) request = previous;
  }
  if (
    !hasSettled(request) ||
    request.reviewSuperseded ||
    request.state === "landed" ||
    request.state === "landing" ||
    request.state === "pending"
  )
    return;
  const settledAt = request.settledAt ?? null;
  // Do not backfill historical outcomes someone already acted on. This is a legacy-only
  // safeguard, not a dependency on reading or handling normal task reports.
  if (
    !settledAt &&
    document.completionInbox?.some(
      (item) =>
        (item.id === request.id || item.id === root.id || item.id === sessionId) &&
        item.sessionId === sessionId &&
        (item.state === "handled" || item.state === "dismissed"),
    )
  )
    return;
  const preference = landing.autoMergeProjects?.find((item) => item.projectPath === projectPath);
  const operation = landing.operations.get(request.workspacePath);
  const waitingForRepair =
    request.state === "canceled" && request.message === "Repair requires fresh readiness";
  // Successful repair retires the old commit before the new turn necessarily settles.
  if (
    waitingForRepair &&
    operation?.automatic &&
    operation.autoMergeRequestId === request.id &&
    !operation.cancellationRequested &&
    ["resolving", "validating", "stalled"].includes(operation.phase)
  )
    return;
  let reason: string | undefined;
  if (request.outcome?.merged && !request.outcome.resolutionSucceeded)
    reason = `Review session resolution; the work was already merged. ${request.outcome.message}`;
  else if (waitingForRepair)
    reason =
      "Auto-merge repair was interrupted before fresh validated readiness. Inspect the worktree before retrying.";
  else if (request.state === "failed" || request.state === "canceled")
    reason = `Review the worktree before proceeding. ${request.outcome?.message ?? request.message ?? "Automatic landing did not finish."}`;
  else if (project.settings?.worktreeLanding === "pull-request")
    reason =
      "Review the completed work and follow the project’s pull request process; Cake cannot merge it.";
  else if (request.runId !== landing.autoMergeRunId)
    reason =
      "Review the worktree. Auto-merge authorization expired at restart; fresh readiness is required for automatic landing.";
  else if (!isDirectProjectChatDelegation(document, request, projectChatSessionId(projectPath)))
    reason =
      "Review and merge manually if appropriate; this task was not directly delegated by Project Chat.";
  else if (!preference?.enabled)
    reason = "Auto-merge is off. Review the changes and merge manually if appropriate.";
  else if (request.epoch !== preference.epoch)
    reason = "Review the worktree. Auto-merge authorization changed; fresh readiness is required.";
  else {
    const pending = document.turns.filter((turn) => turn.sessionId === sessionId && !turn.reported);
    const incomplete = document.spawnedSessions.some(
      (spawn) => spawn.sessionId === sessionId && !spawn.handoffSettled,
    );
    const exhausted = pending.find(
      (turn) => (turn.deliveryFailureCount ?? 0) >= NOTICE_DELIVERY_MAX_FAILURES,
    );
    const overdue = settledAt !== null && now - Date.parse(settledAt) >= HANDOFF_GRACE_MS;
    if (exhausted || (overdue && (pending.length || incomplete)))
      reason = `Review the completed work; auto-merge is waiting for result handoff${exhausted ? " (delivery retries exhausted)" : ""}. ${exhausted?.deliveryError ?? "Check the outstanding session delivery."}`;
    else if (
      overdue &&
      (request.message === "Waiting for session to become idle" ||
        (operation && !["failed", "landed", "complete"].includes(operation.phase)))
    )
      reason =
        "Review the completed work; auto-merge is still waiting for the worktree to become available.";
  }
  return reason
    ? {
        id: `delegated-completion:${root.id}`,
        workspacePath: request.workspacePath,
        settledAt,
        reason,
      }
    : undefined;
}

/** A restart-safe projection of outstanding decisions, never an input or landing scheduler. */
export const reconcile = Effect.fn("DelegatedCompletionReviews.reconcile")(function* () {
  const storage = yield* SessionFamilyStorage;
  const application = yield* ApplicationState;
  const document = yield* storage.state();
  const now = yield* Clock.currentTimeMillis;
  const landing = yield* landingState();
  const state = application.snapshot();
  const bySession = new Map<string, AutoMergeRequest[]>();
  for (const request of document.autoMergeRequests ?? []) {
    const requests = bySession.get(request.sessionId);
    if (requests) requests.push(request);
    else bySession.set(request.sessionId, [request]);
  }
  for (const owner of document.sessionPurposes ?? []) {
    const review = decision(
      owner,
      document,
      bySession.get(owner.sessionId) ?? [],
      state,
      landing,
      now,
    );
    if (!review) continue;
    yield* reviewDelegatedResult(
      { ...review, sessionId: owner.sessionId },
      Effect.gen(function* () {
        const configuration = yield* ProjectSessionConfiguration;
        if (
          (yield* resolutionNamespace(owner.sessionId, {
            cwd: review.workspacePath,
            activeRoot: configuration.sessionDirectory,
            resolvedRoot: configuration.resolvedSessionDirectory,
          })) === "resolved"
        )
          return false;
        const latest = yield* storage.state();
        const relationship = latest.sessionPurposes?.find(
          (item) => item.sessionId === owner.sessionId,
        );
        // Recheck after the archive lookup: a new assignment, resolution, or landing may have won.
        const current =
          relationship &&
          decision(
            relationship,
            latest,
            latest.autoMergeRequests?.filter((item) => item.sessionId === owner.sessionId) ?? [],
            application.snapshot(),
            yield* landingState(),
            now,
          );
        return current?.id === review.id && current.reason === review.reason;
      }),
    ).pipe(
      Effect.catch((error) => Effect.logWarning("Could not surface delegated completion", error)),
    );
  }
});
