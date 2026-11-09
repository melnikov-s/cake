import { Effect, SubscriptionRef } from "effect";
import { isDirectProjectChatDelegation } from "../../contracts/worktrees/auto-merge-delegation";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
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
import * as landings from "./worktreeLandings";
import * as worktreeLifecycle from "./worktreeLifecycle";

const emptyRequests: ReadonlyArray<AutoMergeRequest> = [];

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
      operation.sessionId === request.sessionId &&
      requests.some(
        (previous) =>
          operation.autoMergeRequestId === previous.id &&
          (previous.repairAttempt ?? 0) + 1 === request.repairAttempt,
      );
    // Pi can retire active input before its completion hooks finish. A repair
    // declaration may still be pending when promptAndWait returns; only the
    // normal successful-settlement path may promote it to an authorized retry.
    if (
      repairPredecessor &&
      request.state === "canceled" &&
      !request.readyToMerge &&
      operation.phase === "stalled"
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
      owner?.projectPath !== request.projectPath ||
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
                : [...current.operations.values()].some(
                      (item) =>
                        !["landed", "complete", "failed", "stalled"].includes(item.phase) &&
                        !(
                          item.automatic &&
                          item.phase === "resolving" &&
                          item.workspacePath !== request.workspacePath
                        ),
                    )
                  ? "Waiting for another landing"
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
        owner?.projectPath !== request.projectPath ||
        !isDirectProjectChatDelegation(
          document.spawnedSessions,
          request,
          projectChatSessionId(authorizedProject.projectPath),
        ) ||
        !application.snapshot().projects.some((item) => item.path === request.projectPath) ||
        latest?.state !== "landing" ||
        latest.runId !== authorization.autoMergeRunId ||
        !latest.readyToMerge ||
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
    if (operation?.phase === "stalled" && !operation.automatic) {
      yield* finish(request, "failed", "A manual landing is stalled; finish or cancel it first");
      continue;
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
          repair: (text) =>
            Effect.gen(function* () {
              // Retire the immutable declaration before admitting a repair input. A
              // toggle cycle must not resurrect validation of the pre-repair commit.
              yield* storage.invalidateAutoMerge(request.workspacePath, request.id);
              if ((request.repairAttempt ?? 0) >= 2)
                return yield* new WorktreeLandingError({
                  operation: "repair",
                  message:
                    "Automatic repair stopped after two repair turns with recurring conflicts; no merge or resolution occurred.",
                });
              yield* agent.promptAndWait({
                sessionId: request.sessionId,
                text: `${text}\n\nAutomatic landing repair: own routine merge/rebase conflicts. If Git already completed a clean rebase, review the updated commits. Revalidate the final changes with task-scoped checks, commit, then call worktrees.reportReadiness with that exact HEAD. Do not call worktrees.merge, resolve sessions, or change Auto-merge. Cake will retry only after successful turn completion and fresh current authorization. Report genuine repair failures or ambiguous design/permission decisions honestly.`,
              });
              const status = yield* worktrees.status(request.workspacePath);
              const fresh = (yield* storage.state()).autoMergeRequests?.find(
                (item) =>
                  item.id !== request.id &&
                  item.sessionId === request.sessionId &&
                  item.workspacePath === request.workspacePath &&
                  item.runId === request.runId &&
                  item.repairAttempt === (request.repairAttempt ?? 0) + 1 &&
                  item.readyToMerge &&
                  (item.state === "pending" || item.state === "ready") &&
                  item.commit !== request.commit,
              );
              if (!status || status.dirtyCount > 0 || status.merging || status.rebasing || !fresh)
                return yield* new WorktreeLandingError({
                  operation: "repair",
                  message:
                    "Automatic repair did not produce clean committed changes and fresh validated completion; no retry or resolution occurred.",
                });
            }).pipe(
              Effect.mapError(
                (error) =>
                  new WorktreeLandingError({ operation: "repair", message: error.message }),
              ),
              Effect.tapError((error) =>
                storage.invalidateAutoMerge(request.workspacePath).pipe(
                  Effect.andThen(finish(request, "failed", error.message)),
                  Effect.mapError(
                    (failure) =>
                      new WorktreeLandingError({ operation: "repair", message: failure.message }),
                  ),
                ),
              ),
            ),
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
