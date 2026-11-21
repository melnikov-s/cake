import { Effect, Option, SubscriptionRef } from "effect";
import { isDirectProjectChatDelegation } from "../../contracts/worktrees/auto-merge-delegation";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { sessionPurpose } from "../../contracts/project-sessions/session-purpose";
import {
  WorktreeLandingError,
  type WorktreeLandingOperation,
} from "../../contracts/worktrees/worktree-landing-data";
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
  // SubscriptionRef.update publishes even when its callback returns the same state.
  // An idle worker pass must not resend every retained operation to the renderer.
  yield* SubscriptionRef.updateSome(coordinator.state, (state) =>
    state.autoMergeRequests === requests
      ? Option.none()
      : Option.some({ ...state, autoMergeRequests: requests }),
  );
  const operationIdOf = (request: AutoMergeRequest) =>
    request.attempt ? `${request.id}:${request.attempt}` : request.id;
  const matchesOperation = (
    request: AutoMergeRequest,
    operation: WorktreeLandingOperation | undefined,
  ) =>
    operation?.automatic === true &&
    operation.operationId === operationIdOf(request) &&
    operation.sessionId === request.sessionId;

  const readReceipt = Effect.fn("AutoMerge.readReceipt")(function* (request: AutoMergeRequest) {
    const record = (yield* worktrees.records()).find(
      (item) => item.worktreePath === request.workspacePath,
    );
    const receipt = record?.automaticLandingReceipt;
    return {
      record,
      receipt:
        (record?.state === "landed" ||
          (record?.state === "resolved" && record.resolvedFrom === "landed")) &&
        receipt?.operationId === operationIdOf(request) &&
        receipt.sessionId === request.sessionId &&
        receipt.commit === request.commit
          ? receipt
          : undefined,
    };
  });
  const finish = Effect.fn("AutoMerge.finish")(function* (
    request: AutoMergeRequest,
    state: AutoMergeRequest["state"],
    message: string,
    retire = false,
  ) {
    let outcome: AutoMergeOutcome | undefined;
    if (state === "landed" || state === "failed") {
      const { record, receipt } = yield* readReceipt(request);
      const operation = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
        request.workspacePath,
      );
      const confirmed =
        receipt !== undefined ||
        (matchesOperation(request, operation) && operation?.landedCommit === request.commit);
      outcome = {
        targetBranch: record?.baseBranch ?? "unknown",
        merged: confirmed,
        resolutionSucceeded: confirmed && state === "landed",
        message,
        ...(confirmed ? { landedCommit: request.commit } : null),
      };
      retire ||= confirmed && state !== "landed";
    }
    const applied = yield* storage.updateAutoMerge(
      request.id,
      state,
      message,
      outcome,
      request,
      retire ? false : undefined,
    );
    if (applied)
      yield* SubscriptionRef.update(coordinator.state, (current) => ({
        ...current,
        autoMergeProjects: current.autoMergeProjects?.map((item) =>
          item.projectPath === request.projectPath && item.epoch === request.epoch
            ? { ...item, status: message }
            : item,
        ),
      }));
  });
  for (const request of requests) {
    const operationId = operationIdOf(request);
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
        if (state.operations.get(request.workspacePath) !== operation) return state;
        const operations = new Map(state.operations);
        operations.set(request.workspacePath, { ...operation, phase: "failed", error });
        return { ...state, operations };
      });
      yield* finish(request, "failed", error);
      continue;
    }
    if (request.state === "landing" || (request.state === "canceled" && !request.outcome)) {
      if (matchesOperation(request, operation) && operation) {
        if (
          operation.phase === "landed" ||
          (operation.phase === "failed" && operation.landedCommit === request.commit)
        ) {
          const resolved = operation.resolvedSessionIds?.includes(request.sessionId) === true;
          yield* finish(
            request,
            resolved ? "landed" : "failed",
            resolved
              ? operation.cleanupFailures?.length
                ? `Auto-merged and resolved; cleanup needs attention: ${operation.cleanupFailures.map((failure) => failure.message).join("; ")}`
                : "Auto-merged and resolved"
              : `Merged, but session resolution was not confirmed${operation.resolutionError ? `: ${operation.resolutionError}` : ""}`,
          );
        } else if (
          request.state === "landing" &&
          (operation.phase === "failed" || operation.phase === "stalled")
        ) {
          yield* finish(
            request,
            "failed",
            operation.error ?? "Auto-merge blocked; session remains unresolved",
            operation.phase === "stalled",
          );
        }
        continue;
      }
      // Recovery must never replay Git. Both the landing receipt and the later
      // resolution admission must belong to this attempt.
      const { record, receipt } = yield* readReceipt(request);
      if (receipt && record?.state === "resolved") {
        yield* finish(request, "landed", "Auto-merged and resolved");
      } else if (
        receipt &&
        request.state === "landing" &&
        receipt.resolutionAuthorized &&
        record?.resolveAfterLanding
      ) {
        const recovered = yield* landings
          .inspect({
            workspacePath: request.workspacePath,
            sessionId: request.sessionId,
            automaticOperationId: operationId,
          })
          .pipe(Effect.result);
        if (recovered._tag === "Failure")
          yield* finish(
            request,
            "failed",
            `Merged; resolution recovery failed: ${recovered.failure.message}`,
          );
        else {
          const after = yield* readReceipt(request);
          const resolved = after.receipt && after.record?.state === "resolved";
          yield* finish(
            request,
            resolved ? "landed" : "failed",
            resolved ? "Auto-merged and resolved" : "Merged; resolution could not be confirmed",
          );
        }
      } else if (receipt) {
        yield* finish(request, "failed", "Merged, but session resolution was not confirmed");
      } else if (request.state === "landing") {
        yield* finish(
          request,
          "failed",
          "Auto-merge interrupted; inspect the managed worktree before retrying. No landing was replayed.",
        );
      }
      continue;
    }
    if (request.state !== "ready" && request.state !== "pending") continue;
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
        true,
      );
      continue;
    }
    if (request.runId !== current.autoMergeRunId) {
      yield* finish(
        request,
        "canceled",
        "Auto-merge authorization expired; fresh validated completion required",
        true,
      );
      continue;
    }
    // A repair declaration belongs to its live predecessor operation. Dismissal
    // must not turn that follow-up into an independent task (or survive off/on).
    if (request.repairAttempt !== undefined && !repairPredecessor) {
      yield* finish(
        request,
        "canceled",
        "Automatic repair was canceled; fresh task readiness required",
        true,
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
      yield* finish(
        request,
        "canceled",
        "Owning project is unavailable; fresh readiness required",
        true,
      );
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
                  document,
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
      yield* storage.updateAutoMerge(request.id, request.state, reason, undefined, request);
      continue;
    }
    if (project?.epoch !== request.epoch) {
      yield* finish(
        request,
        "canceled",
        "Auto-merge authorization expired; fresh validated completion required",
        true,
      );
      continue;
    }
    const authorize = (repairReminder = false) =>
      Effect.gen(function* () {
        const owner = (yield* worktrees.records()).find(
          (item) => item.worktreePath === request.workspacePath,
        );
        const busy = (yield* sessions.activeWorkingDirectories()).includes(request.workspacePath);
        const document = yield* storage.state();
        const authorization = yield* SubscriptionRef.get(coordinator.state);
        const latest = document.autoMergeRequests?.find((item) => item.id === request.id);
        const authorizedProject = authorization.autoMergeProjects?.find(
          (item) => item.projectPath === request.projectPath,
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
            document,
            request,
            projectChatSessionId(authorizedProject.projectPath),
          ) ||
          !application
            .snapshot()
            .projects.some(
              (item) =>
                item.path === request.projectPath &&
                item.autoMergeEnabled &&
                item.settings?.worktreeLanding !== "pull-request",
            ) ||
          latest?.state !== "landing" ||
          latest.attempt !== request.attempt ||
          latest.runId !== authorization.autoMergeRunId ||
          latest.runId !== request.runId ||
          latest.epoch !== request.epoch ||
          latest.readyToMerge === repairReminder ||
          authorization.operations.get(request.workspacePath)?.operationId !== operationId ||
          authorization.operations.get(request.workspacePath)?.cancellationRequested === true ||
          latest.commit !== request.commit ||
          document.turns.some((turn) => turn.sessionId === request.sessionId && !turn.reported) ||
          document.spawnedSessions.some(
            (spawn) => spawn.sessionId === request.sessionId && !spawn.handoffSettled,
          ) ||
          busy
        )
          return yield* new WorktreeLandingError({
            operation: "autoMerge",
            message:
              "Auto-merge was disabled or readiness became stale; session remains unresolved",
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
    const admitted = { ...request, state: "landing" as const };
    if (!(yield* storage.updateAutoMerge(request.id, "landing", undefined, undefined, request)))
      continue;
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
          authorize: authorize(),
          revalidate: (text, reason, repairFingerprint) => {
            const cleanRebase = reason === "clean-rebase";
            const label = cleanRebase ? "Automatic clean-rebase validation" : "Automatic repair";
            const operation = cleanRebase ? "revalidation" : "repair";
            const repairing = { ...admitted, readyToMerge: false };
            let expected = admitted;
            return Effect.gen(function* () {
              yield* authorize();
              // Retire Git permission, retaining the attempt while its repair is in flight.
              const retired = yield* storage.updateAutoMerge(
                request.id,
                "landing",
                undefined,
                undefined,
                admitted,
                false,
              );
              if (!retired)
                return yield* new WorktreeLandingError({
                  operation,
                  message: "Automatic repair lost authorization; no retry or resolution occurred.",
                });
              expected = repairing;
              if (!cleanRebase) {
                if (!repairFingerprint)
                  return yield* new WorktreeLandingError({
                    operation,
                    message:
                      "Automatic repair stopped: Git repair progress could not be determined; no merge or resolution occurred.",
                  });
                const progress = (yield* SubscriptionRef.get(coordinator.state))
                  .autoMergeRepairProgress;
                let ancestor: AutoMergeRequest | undefined = request;
                while (ancestor) {
                  if (progress?.get(ancestor.id) === repairFingerprint)
                    return yield* new WorktreeLandingError({
                      operation,
                      message:
                        "Automatic repair stopped: the same conflicts recurred with unchanged source content and target commit after an earlier repair; no progress, merge or resolution occurred.",
                    });
                  const predecessorId: string | undefined = ancestor.repairOfRequestId;
                  ancestor = requests.find(
                    (item) =>
                      item.id === predecessorId &&
                      item.sessionId === request.sessionId &&
                      item.workspacePath === request.workspacePath &&
                      item.runId === request.runId,
                  );
                }
                yield* SubscriptionRef.update(coordinator.state, (state) => ({
                  ...state,
                  autoMergeRepairProgress: new Map(state.autoMergeRepairProgress).set(
                    request.id,
                    repairFingerprint,
                  ),
                }));
              }
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
                yield* authorize(true);
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
              yield* storage.updateAutoMerge(
                request.id,
                "canceled",
                "Repair requires fresh readiness",
                undefined,
                repairing,
              );
            }).pipe(
              Effect.mapError(
                (error) => new WorktreeLandingError({ operation, message: error.message }),
              ),
              Effect.tapError((error) =>
                finish(expected, "failed", error.message, true).pipe(
                  Effect.andThen(
                    landings
                      .revokeReadiness(request.workspacePath, request.id)
                      .pipe(Effect.provideService(SessionFamilyStorage, storage)),
                  ),
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
      .pipe(Effect.catch((error) => finish(admitted, "failed", error.message)));
    // Read the next request only after the launched operation is observed on a later pass.
    return;
  }
});
