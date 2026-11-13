import { Effect, SubscriptionRef } from "effect";
import { isDirectProjectChatDelegation } from "../../contracts/worktrees/auto-merge-delegation";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { sessionPurpose } from "../../contracts/project-sessions/session-purpose";
import { WorktreeLandingError } from "../../contracts/worktrees/worktree-landing-data";
import type { AutoMergeOutcome, AutoMergeRequest } from "../../contracts/worktrees/auto-merge";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import * as readiness from "./autoMergeReadiness";
import * as landings from "./worktreeLandings";
import * as worktreeLifecycle from "./worktreeLifecycle";

const emptyRequests: ReadonlyArray<AutoMergeRequest> = [];

/** Why the latest follow-up turn did not leave a landable declaration, or undefined. */
const validationProblem = Effect.fn("AutoMerge.validationProblem")(function* (
  request: AutoMergeRequest,
  cleanRebase: boolean,
) {
  const inspected = yield* readiness.inspectReadyHead(request.workspacePath);
  if (inspected.problem !== undefined) return inspected.problem;
  const declaration = ((yield* (yield* SessionFamilyStorage).state()).autoMergeRequests ?? [])
    .filter(
      (item) =>
        item.id !== request.id &&
        item.sessionId === request.sessionId &&
        item.workspacePath === request.workspacePath &&
        item.runId === request.runId &&
        item.repairAttempt === (request.repairAttempt ?? 0) + 1 &&
        item.repairOfRequestId === request.id,
    )
    .at(-1);
  if (!declaration)
    return `No readiness was reported after the ${cleanRebase ? "clean-rebase validation" : "repair"}. HEAD is ${inspected.head}.`;
  if (
    !declaration.readyToMerge ||
    (declaration.state !== "pending" && declaration.state !== "ready")
  )
    return `Readiness for ${declaration.commit} was withdrawn or invalidated${declaration.message ? ` (${declaration.message})` : ""}. HEAD is ${inspected.head}.`;
  if (declaration.commit === request.commit)
    return cleanRebase
      ? `Readiness names the pre-rebase commit ${request.commit}; the rebased HEAD must be revalidated and declared.`
      : `Readiness names the pre-repair commit ${request.commit}; the repaired HEAD must be revalidated and declared.`;
  if (declaration.commit !== inspected.head)
    return `Readiness was declared for ${declaration.commit}, but HEAD is now ${inspected.head}.`;
  return undefined;
});

/** Single worker pass. The existing engine owns the repository FIFO and Git safety. */
export const runPass = Effect.fn("AutoMerge.runPass")(function* () {
  const storage = yield* SessionFamilyStorage;
  const coordinator = yield* WorktreeLandingCoordinator;
  const worktrees = yield* ManagedWorktrees;
  const sessions = yield* CakeSessionRuntimes;
  const application = yield* ApplicationState;
  const clientEvents = yield* ClientEvents;
  const renderer = yield* RendererRequestCoordinator;
  const agent = yield* WorktreeLandingAgent;
  yield* landings.reconcileCancellations();
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
      autoMergeProjects: current.autoMergeProjects?.map((item) =>
        item.projectPath === request.projectPath ? { ...item, status: message } : item,
      ),
    }));
  });
  for (const request of requests) {
    const operationId = request.attempt ? `${request.id}:${request.attempt}` : request.id;
    const current = yield* SubscriptionRef.get(coordinator.state);
    const operation = current.operations.get(request.workspacePath);
    const repairPredecessor =
      request.repairAttempt !== undefined &&
      operation?.automatic &&
      !operation.cancellationRequested &&
      (operation.phase === "resolving" ||
        operation.phase === "validating" ||
        operation.phase === "stalled") &&
      operation.sessionId === request.sessionId &&
      requests.some(
        (previous) =>
          operation.autoMergeRequestId === previous.id &&
          request.repairOfRequestId === previous.id &&
          previous.workspacePath === request.workspacePath &&
          previous.sessionId === request.sessionId &&
          previous.projectPath === request.projectPath &&
          previous.runId === request.runId &&
          (previous.repairAttempt ?? 0) + 1 === request.repairAttempt,
      );
    // Pi can retire active input before its completion hooks finish. A repair
    // declaration may still be pending when promptAndWait returns; only the
    // normal successful-settlement path may promote it to an authorized retry.
    // A reminder turn supersedes an earlier invalid declaration of the same round.
    if (
      repairPredecessor &&
      request.state === "canceled" &&
      !request.readyToMerge &&
      operation.phase === "stalled" &&
      requests.findLast(
        (item) =>
          item.repairOfRequestId === request.repairOfRequestId &&
          item.repairAttempt === request.repairAttempt &&
          item.workspacePath === request.workspacePath &&
          item.sessionId === request.sessionId &&
          item.runId === request.runId,
      ) === request
    ) {
      const error =
        request.message ??
        "Repair turn did not complete successfully; no retry or resolution occurred";
      yield* SubscriptionRef.update(coordinator.state, (state) => {
        if (state.operations.get(request.workspacePath)?.operationId !== operation.operationId)
          return state;
        const operations = new Map(state.operations);
        operations.set(request.workspacePath, { ...operation, phase: "failed", error });
        return { ...state, operations };
      });
      yield* finish(request, "failed", error);
      continue;
    }
    if (request.state !== "ready" && request.state !== "landing" && request.state !== "pending")
      continue;
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
          if (operation.phase === "stalled")
            yield* storage.invalidateAutoMerge(request.workspacePath, request.id);
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
    const policyRecord = (yield* worktrees.records()).find(
      (item) => item.worktreePath === request.workspacePath,
    );
    if (
      policyRecord &&
      (yield* worktreeLifecycle.forProject(policyRecord.projectPath)).landsThroughPullRequests
    ) {
      yield* finish(
        request,
        "canceled",
        "This project merges outside Cake; auto-merge is unavailable.",
      );
      continue;
    }
    if (request.runId !== current.autoMergeRunId) {
      yield* storage.invalidateAutoMerge(request.workspacePath, request.id);
      continue;
    }
    // A repair declaration belongs to its live predecessor operation. Dismissal
    // must not turn that follow-up into an independent task (or survive off/on).
    if (request.repairAttempt !== undefined && !repairPredecessor) {
      yield* storage.invalidateAutoMerge(request.workspacePath, request.id);
      yield* finish(
        request,
        "canceled",
        "Automatic repair was canceled; fresh task readiness required",
      );
      continue;
    }
    const owner = (yield* worktrees.records()).find(
      (item) => item.worktreePath === request.workspacePath,
    );
    if (
      !request.projectPath ||
      !owner ||
      owner.projectPath !== request.projectPath ||
      owner.state === "resolved" ||
      owner.state === "missing" ||
      owner.state === "discarded" ||
      !application.snapshot().projects.some((item) => item.path === request.projectPath)
    ) {
      yield* finish(request, "canceled", "Owning project is unavailable; fresh readiness required");
      continue;
    }
    const owningProjectChatSessionId = projectChatSessionId(request.projectPath);
    const project = current.autoMergeProjects?.find(
      (item) => item.projectPath === request.projectPath,
    );
    const document = yield* storage.state();
    const pendingHandoffs = document.turns.filter(
      (turn) => turn.sessionId === request.sessionId && !turn.reported,
    );
    const handoffError = pendingHandoffs.find((turn) => turn.deliveryError)?.deliveryError;
    const waiting =
      pendingHandoffs.length > 0 ||
      document.spawnedSessions.some(
        (spawn) => spawn.sessionId === request.sessionId && !spawn.handoffSettled,
      );
    const reason =
      request.state === "pending"
        ? "Waiting for task completion"
        : waiting
          ? `Waiting for result handoff${handoffError ? `: ${handoffError}` : ""}`
          : sessionPurpose(document, request.sessionId) !== "delegated"
            ? "Manual landing only: User Sessions (My sessions) never auto-merge"
            : !isDirectProjectChatDelegation(
                  document.spawnedSessions,
                  request,
                  projectChatSessionId(request.projectPath),
                )
              ? "Manual landing only: not directly delegated by this project’s Project Chat"
              : !project?.enabled
                ? "Auto-merge is off; ready for manual landing"
                : (yield* sessions.activeWorkingDirectories()).includes(request.workspacePath)
                  ? "Waiting for session to become idle"
                  : undefined;
    if (reason) {
      yield* storage.updateAutoMerge(request.id, request.state, reason);
      continue;
    }
    if (project?.epoch !== request.epoch) {
      yield* finish(
        request,
        "canceled",
        "Auto-merge authorization expired; fresh validated completion required",
      );
      continue;
    }
    const authorize = Effect.gen(function* () {
      const authorization = yield* SubscriptionRef.get(coordinator.state);
      const document = yield* storage.state();
      const latest = document.autoMergeRequests?.find((item) => item.id === request.id);
      const authorizedProject = authorization.autoMergeProjects?.find(
        (item) => item.projectPath === request.projectPath,
      );
      const owner = (yield* worktrees.records()).find(
        (item) => item.worktreePath === request.workspacePath,
      );
      if (
        !authorizedProject?.enabled ||
        authorizedProject.epoch !== request.epoch ||
        !owner ||
        owner.projectPath !== request.projectPath ||
        owner.state === "resolved" ||
        owner.state === "missing" ||
        owner.state === "discarded" ||
        sessionPurpose(document, request.sessionId) !== "delegated" ||
        !isDirectProjectChatDelegation(
          document.spawnedSessions,
          request,
          projectChatSessionId(authorizedProject.projectPath),
        ) ||
        !application.snapshot().projects.some((item) => item.path === request.projectPath) ||
        latest?.state !== "landing" ||
        latest.runId !== authorization.autoMergeRunId ||
        latest.runId !== request.runId ||
        latest.epoch !== request.epoch ||
        !latest.readyToMerge ||
        (authorization.operations.get(request.workspacePath)?.autoMergeRequestId === request.id &&
          authorization.operations.get(request.workspacePath)?.cancellationRequested === true) ||
        latest.commit !== request.commit ||
        document.turns.some((turn) => turn.sessionId === request.sessionId && !turn.reported) ||
        document.spawnedSessions.some(
          (spawn) => spawn.sessionId === request.sessionId && !spawn.handoffSettled,
        ) ||
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
    // Reconcile the source operation before scheduling. Unrelated operations are
    // admitted by the engine's repository-keyed FIFO, not an app-wide scheduler gate.
    if (operation && !["landed", "complete", "failed"].includes(operation.phase)) {
      if (operation.phase !== "stalled") continue;
      if (!operation.automatic) {
        yield* finish(request, "failed", "A manual landing is stalled; finish or cancel it first");
        continue;
      }
      // start atomically replaces only a parked automatic attempt. Do not cancel:
      // its Git recovery metadata must survive the fresh authorized attempt.
      yield* worktrees.releaseLanding(request.workspacePath, operation.operationId);
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
        automatic: {
          requestId: request.id,
          commit: request.commit,
          authorize,
          revalidate: (text, reason) => {
            const cleanRebase = reason === "clean-rebase";
            const label = cleanRebase ? "Automatic clean-rebase validation" : "Automatic repair";
            const operation = cleanRebase ? "revalidation" : "repair";
            return Effect.gen(function* () {
              yield* authorize;
              // Retire the immutable declaration before admitting a follow-up input.
              // A toggle cycle must not resurrect validation of the old commit.
              yield* storage.invalidateAutoMerge(request.workspacePath, request.id);
              if ((request.repairAttempt ?? 0) >= 2)
                return yield* new WorktreeLandingError({
                  operation,
                  message: cleanRebase
                    ? `${label} stopped after two validation turns; no merge or resolution occurred.`
                    : "Automatic repair stopped after two repair turns with recurring conflicts; no merge or resolution occurred.",
                });
              const outcome = yield* agent.promptAndWait({
                sessionId: request.sessionId,
                text: cleanRebase
                  ? `${text}\n\nAutomatic clean-rebase validation: call worktrees.reportReadiness after the final-HEAD checks pass; Cake records the current HEAD. No new commit is needed unless validation requires code changes. Do not call worktrees.merge, resolve sessions, or change Auto-merge. Cake will retry only after successful turn completion and fresh current authorization. Report validation failures honestly.`
                  : `${text}\n\nAutomatic landing repair: own routine merge/rebase conflicts. Revalidate the final changes with task-scoped checks, commit, then call worktrees.reportReadiness; Cake records the current HEAD, so no commit hash is needed. Do not call worktrees.merge, resolve sessions, or change Auto-merge. Cake will retry only after successful turn completion and fresh current authorization. Report genuine repair failures or ambiguous design/permission decisions honestly.`,
              });
              let problem = yield* validationProblem(request, cleanRebase).pipe(
                Effect.provideService(ManagedWorktrees, worktrees),
                Effect.provideService(SessionFamilyStorage, storage),
              );
              // Missing, invalid or withdrawn readiness after a successful turn gets exactly
              // one specific reminder. Stopped, failed or unknown turns are never re-prompted.
              if (problem && outcome === "complete") {
                yield* landings
                  .revokeReadiness(request.workspacePath, request.id)
                  .pipe(Effect.provideService(SessionFamilyStorage, storage));
                yield* agent.promptAndWait({
                  sessionId: request.sessionId,
                  text: cleanRebase
                    ? `${label} is not finished: ${problem}\n\nFinish task-scoped checks against the final HEAD, then call worktrees.reportReadiness {readyToMerge: true, taskCompleted: true, validationPassed: true}. No new commit is needed unless code changes are required. Do not call worktrees.merge, resolve sessions, or change Auto-merge. This is the only reminder: if readiness is still missing or invalid when this turn ends, automatic landing stops. Report any validation blocker instead of reporting readiness.`
                    : `Automatic landing repair is not finished: ${problem}\n\nFinish the repair, commit, rerun task-scoped checks if the code changed, then call worktrees.reportReadiness {readyToMerge: true, taskCompleted: true, validationPassed: true}; Cake records the current HEAD. Do not call worktrees.merge, resolve sessions, or change Auto-merge. This is the only reminder: if readiness is still missing or invalid when this turn ends, automatic landing stops. If you cannot finish the repair, say so instead of reporting readiness.`,
                });
                problem = yield* validationProblem(request, cleanRebase).pipe(
                  Effect.provideService(ManagedWorktrees, worktrees),
                  Effect.provideService(SessionFamilyStorage, storage),
                );
              }
              if (problem)
                return yield* new WorktreeLandingError({
                  operation,
                  message: `${
                    outcome === "complete"
                      ? `${label} stopped after one reminder`
                      : outcome
                        ? `${label} turn ${outcome === "aborted" ? "was stopped" : "failed"}`
                        : `${label} turn ended with an unknown outcome`
                  } without fresh validated completion: ${problem} No retry or resolution occurred.`,
                });
            }).pipe(
              Effect.mapError(
                (error) => new WorktreeLandingError({ operation, message: error.message }),
              ),
              Effect.tapError((error) =>
                landings.revokeReadiness(request.workspacePath, request.id).pipe(
                  Effect.provideService(SessionFamilyStorage, storage),
                  Effect.andThen(finish(request, "failed", error.message)),
                  Effect.mapError(
                    (failure) => new WorktreeLandingError({ operation, message: failure.message }),
                  ),
                ),
              ),
            );
          },
          onLanded: Effect.gen(function* () {
            // Project Chat outlives source-session resolution. Its existing binding owns
            // notification delivery; never broadcast to other projects/windows or replay.
            const connectionId = yield* renderer.connectionForSession(owningProjectChatSessionId);
            if (connectionId === undefined) return;
            const spawn = document.spawnedSessions.find(
              (item) => item.sessionId === request.sessionId,
            );
            clientEvents.sendTo(connectionId, {
              type: "auto-merge-landed",
              operationId,
              sessionId: request.sessionId,
              title: spawn?.title || `Session ${request.sessionId}`,
            });
          }),
        },
      })
      .pipe(Effect.catch((error) => finish(request, "failed", error.message)));
    // Read the next request only after the launched operation is observed on a later pass.
    return;
  }
});
