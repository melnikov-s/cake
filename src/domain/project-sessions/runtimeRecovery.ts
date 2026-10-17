import { Effect } from "effect";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import { acquireTarget } from "./projectSessionOperations";
import { locations } from "./projectSessionLocations";
import * as cakeChatTargets from "../cake-chats/cakeChatTargets";

/** Reacquire only durable active intents; visiting/selecting a chat is not admission. */
export const initialize = Effect.fn("RuntimeRecovery.initialize")(function* () {
  const storage = yield* RuntimeRecoveryStorage;
  const availableLocations = yield* locations();
  for (const record of yield* storage.list()) {
    // Private workers are restored by their handle/capability owner before parent turns.
    if (record.profile === "SubagentSession") continue;
    if ((record.state !== "active" && record.state !== "stopped") || record.inputs.length === 0)
      continue;
    // Durable owns stopped coordinator queues and does not need a new admission.
    if (record.profile === "CakeChatSession" && record.state === "stopped") continue;
    const recovered = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          if (record.profile === "CakeChatSession") {
            const handle = yield* cakeChatTargets.acquire(record.sessionId);
            yield* handle.recover(record.inputs);
            return;
          }
          const location = availableLocations.find(
            (item) =>
              item.workingDirectory === record.workingDirectory &&
              item.sessionDirectory === record.sessionDirectory,
          );
          if (!location)
            return yield* Effect.fail(
              new Error(
                "The interrupted session's Working Directory is unavailable. Restore it before continuing.",
              ),
            );
          const sessions = yield* CakeSessionRuntimes;
          const persisted = yield* sessions.catalogEntry(
            {
              workingDirectory: record.workingDirectory,
              sessionDirectory: record.sessionDirectory,
            },
            record.sessionId,
          );
          if (persisted === undefined && record.transcriptPersisted)
            return yield* Effect.fail(
              new Error(
                "The saved Pi transcript is missing. Restore it before continuing; the original task will not be replayed.",
              ),
            );
          const handle = yield* acquireTarget(location, record.sessionId, persisted === undefined);
          yield* handle.recover(record.inputs, record.state === "stopped");
        }),
      ),
    );
    if (recovered._tag === "Failure") {
      yield* storage.update({ ...record, state: "blocked", issue: String(recovered.failure) });
      yield* Effect.logWarning(
        "Session restart recovery needs attention",
        record.sessionId,
        recovered.failure,
      );
    }
  }
});
