import * as workboardDeliveries from "./workboardDeliveries";
import * as updateBatches from "./updateBatches";
import * as projectTodoAttention from "../projects/projectTodoAttention";
import { Cause, Effect, Schedule } from "effect";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { deliver } from "./sessionFamilyCompletion";
import {
  NOTICE_DELIVERY_MAX_FAILURES,
  type SessionFamilyChild,
} from "../../contracts/session-families/session-family-document";

export const initialize = Effect.fn("SessionFamilies.initialize")(function* <E, R>(
  activeRoot: string,
  resolvedRoot: string,
  isRecoverable: (sessionId: string, turnId?: string) => Effect.Effect<boolean, E, R>,
) {
  const storage = yield* SessionFamilyStorage;
  const archive = yield* SessionArchiveStorage;
  // Reconcile before family delivery workers or host endpoints are admitted.
  // Index the protecting obligations once, not one freshness check per retained child.
  const initial = yield* storage.state();
  const protectedSessions = new Set(initial.turns.map((turn) => turn.sessionId));
  const candidates = new Map<string, Array<{ child: SessionFamilyChild; familyId: string }>>();
  for (const family of initial.families) {
    for (const child of family.children) {
      // Existing reports and assignment-first handoffs protect routing even when
      // neither a transcript nor recoverable input has been materialized yet.
      if (protectedSessions.has(child.sessionId) || child.assignmentTopic) continue;
      if (yield* isRecoverable(child.sessionId)) continue;
      const group = candidates.get(child.workingDirectory) ?? [];
      group.push({ child, familyId: family.familyId });
      candidates.set(child.workingDirectory, group);
    }
  }
  for (const [cwd, children] of candidates) {
    const present = yield* archive.locateMany(
      children.map(({ child }) => child.sessionId),
      { cwd, activeRoot, resolvedRoot },
    );
    for (const { child, familyId } of children) {
      if (present.has(child.sessionId)) continue;
      if (child.resultDelivery === "ignore") {
        yield* storage.removeUnmaterializedChild(child.sessionId);
        continue;
      }

      // No accepted input or report remains for this unmaterialized reservation.
      yield* storage.recordTurn({
        sessionId: child.sessionId,
        senderSessionId: child.parentSessionId,
        turnId: child.sessionId,
        requestMessageId: child.sessionId,
        threadId: familyId,
        reported: false,
        resultDelivery: child.resultDelivery ?? "notification",
        outcome: "failed",
      });
      yield* storage.removeUnmaterializedChild(child.sessionId);
    }
  }
  const state = yield* storage.state();
  const sessionsWithTurns = new Set(state.turns.map((turn) => turn.sessionId));
  for (const spawn of state.spawnedSessions) {
    if (
      spawn.resultDelivery === "ignore" ||
      spawn.handoffSettled ||
      sessionsWithTurns.has(spawn.sessionId)
    )
      continue;
    if (yield* isRecoverable(spawn.sessionId)) continue;
    // Covers a crash after recording the requester but before Pi accepted its initial input.
    // Spawns created without an initial obligation are registered already settled.
    yield* storage.recordTurn({
      sessionId: spawn.sessionId,
      senderSessionId: spawn.requester.sessionId,
      turnId: spawn.sessionId,
      requestMessageId: spawn.sessionId,
      threadId: spawn.sessionId,
      reported: false,
      outcome: "aborted",
      resultDelivery: spawn.resultDelivery ?? "notification",
    });
  }
  for (const turn of (yield* storage.state()).turns) {
    // Accepted primary inputs may resume after restart. Only genuinely orphaned
    // obligations become interrupted notices; settled reports are never rewritten.
    if (!turn.outcome && !(yield* isRecoverable(turn.sessionId, turn.turnId)))
      yield* storage.settleTurn(turn.turnId, "aborted");
  }
});

/** Admission attempts are bounded, not the task execution they may start. Stable
 * report message IDs and durable receipts reconcile interrupted attempts on retry. */
export const runPass = Effect.fn("SessionFamilies.deliverPendingNotices")(function* () {
  const storage = yield* SessionFamilyStorage;
  const turns = (yield* storage.state()).turns.filter(
    (turn) =>
      turn.outcome &&
      !turn.reported &&
      (turn.deliveryFailureCount ?? 0) < NOTICE_DELIVERY_MAX_FAILURES,
  );
  yield* Effect.forEach(
    turns,
    (turn) =>
      Effect.scoped(deliver(turn)).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            Effect.logError(
              (turn.deliveryFailureCount ?? 0) + 1 >= NOTICE_DELIVERY_MAX_FAILURES
                ? "Session result delivery paused; inspect sessions.deliveries and retry with sessions.deliveries.retry"
                : "Session result delivery will retry",
              cause,
            ).pipe(
              Effect.annotateLogs({ turnId: turn.turnId, sessionId: turn.sessionId }),
              Effect.andThen(storage.markNoticeFailure(turn.turnId, Cause.pretty(cause))),
            ),
        ),
      ),
    { concurrency: 8, discard: true },
  );
});

/** Independent supervised lanes: a stuck Workboard or deferred wake cannot stop
 * durable completion retention. The backend scope still owns cancellation. */
export const runWorker = Effect.gen(function* () {
  const deliverBoards = yield* workboardDeliveries.makePass();
  const repeat = <A, E, R>(name: string, pass: Effect.Effect<A, E, R>) =>
    pass.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => Effect.logError(`${name} pass will retry`, cause),
      ),
      Effect.repeat(Schedule.spaced("1 second")),
    );
  yield* Effect.all(
    [
      repeat("Session result delivery", runPass()),
      repeat("Workboard delivery", deliverBoards().pipe(Effect.timeout("30 seconds"))),
      repeat("Batched update delivery", updateBatches.runPass().pipe(Effect.timeout("30 seconds"))),
      repeat("Queued attention restore", projectTodoAttention.runQueuedPass()),
    ],
    { concurrency: "unbounded", discard: true },
  );
});
