import * as workboardDeliveries from "./workboardDeliveries";
import * as updateBatches from "./updateBatches";
import { Effect, Schedule } from "effect";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { deliver } from "./sessionFamilyCompletion";

export const initialize = Effect.fn("SessionFamilies.initialize")(function* <E, R>(
  activeRoot: string,
  resolvedRoot: string,
  isRecoverable: (sessionId: string, turnId?: string) => Effect.Effect<boolean, E, R>,
) {
  const storage = yield* SessionFamilyStorage;
  const archive = yield* SessionArchiveStorage;
  for (const family of yield* storage.list()) {
    for (const child of family.children) {
      // Durable admission can precede Pi's first transcript write. Recovery, not
      // transcript presence, decides whether this reservation is still live.
      if (yield* isRecoverable(child.sessionId)) continue;
      if (
        yield* archive.locate(child.sessionId, {
          cwd: child.workingDirectory,
          activeRoot,
          resolvedRoot,
        })
      )
        continue;
      // An existing obligation (including a settled report awaiting delivery)
      // must retain its member routing and must not gain a second failure notice.
      if ((yield* storage.state()).turns.some((turn) => turn.sessionId === child.sessionId))
        continue;
      // Assignment-first reservations are explicit retryable handoffs, not orphaned
      // bootstrap sessions. Never erase their request identity or restart them here.
      if (child.assignmentTopic) continue;
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
        threadId: family.familyId,
        reported: false,
        resultDelivery: child.resultDelivery ?? "notification",
        outcome: "failed",
      });
      yield* storage.removeUnmaterializedChild(child.sessionId);
    }
  }
  const state = yield* storage.state();
  for (const spawn of state.spawnedSessions) {
    if (
      spawn.resultDelivery === "ignore" ||
      spawn.handoffSettled ||
      state.turns.some((turn) => turn.sessionId === spawn.sessionId)
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

const runPass = Effect.fn("SessionFamilies.deliverPendingNotices")(function* () {
  yield* workboardDeliveries.runPass();
  const storage = yield* SessionFamilyStorage;
  for (const turn of (yield* storage.state()).turns) {
    if (!turn.outcome || turn.reported) continue;
    yield* Effect.scoped(deliver(turn)).pipe(
      Effect.catch((error) => Effect.logError("Session result delivery will retry", error)),
    );
  }
  // After results settle into deferred stores, so a completion opens its batch this pass.
  yield* updateBatches
    .runPass()
    .pipe(Effect.catch((error) => Effect.logError("Batched update pass will retry", error)));
});

export const runWorker = runPass().pipe(
  Effect.catch((error) => Effect.logError("Session result delivery pass failed", error)),
  Effect.repeat(Schedule.spaced("1 second")),
);
