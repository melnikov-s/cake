import { Effect, Schedule } from "effect";
import { expireOverdue } from "./projectTodos";
import { completeLinked } from "./projectTodoResolution";

/** ApplicationStorage is the sole deadline authority. One backend-scoped worker checks
 * wall-clock time, including after sleep/clock changes; idle passes never write storage.
 * It starts with overdue persisted items and runs without any renderer/chat runtime.
 * Expiry only publishes visibility. It never sends inputs or starts/stops session work.
 */
export const initialize = Effect.fn("ProjectTodoSnoozes.initialize")(function* () {
  const pass = Effect.fn("ProjectTodoSnoozes.expire")(
    function* () {
      const scopes = yield* expireOverdue();
      // Expiry increments revisions. Reconcile just the affected lists so a resolution join
      // racing that revision cannot leave already-resolved work active until next restart.
      for (const scope of scopes) yield* completeLinked(scope);
    },
    Effect.catch((cause) => Effect.logWarning("To-do snooze expiry failed; retrying", cause)),
  );
  // Repair downtime before startup completes; then retain one serialized, scoped pass.
  yield* pass();
  yield* pass().pipe(
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.delay("1 second"),
    Effect.forkScoped,
  );
});
