import { Effect } from "effect";
import { startupDiagnostics } from "../../services/diagnostics/startup-diagnostics";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import { acquireTarget } from "./projectSessionOperations";
import { locations } from "./projectSessionLocations";
import * as cakeChatTargets from "../cake-chats/cakeChatTargets";

/** Reconcile unfinished intents, including earlier failed recovery; observing a chat is not admission. */
export const initialize = Effect.fn("RuntimeRecovery.initialize")(function* () {
  const storage = yield* RuntimeRecoveryStorage;
  const availableLocations = yield* locations();
  for (const record of yield* storage.list()) {
    // Private workers and automations are restored by their owning workflow.
    if (record.profile === "SubagentSession" || record.profile === "AutomationSession") continue;
    if (!["active", "blocked", "stopped"].includes(record.state) || record.inputs.length === 0)
      continue;
    // Durable owns stopped coordinator queues and does not need a new admission.
    if (record.profile === "CakeChatSession" && record.state === "stopped") continue;
    const recovered = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          if (record.profile === "CakeChatSession") {
            const handle = yield* cakeChatTargets.acquireAvailable(record.sessionId);
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
          const persisted = yield* startupDiagnostics.measure(
            "runtime-recovery-transcript-check",
            sessions.hasTranscript({
              workingDirectory: record.workingDirectory,
              sessionDirectory: record.sessionDirectory,
              sessionId: record.sessionId,
            }),
          );
          if (!persisted && record.transcriptPersisted)
            return yield* Effect.fail(
              new Error(
                "The saved Pi transcript is missing. Restore it before continuing; the original task will not be replayed.",
              ),
            );
          const handle = yield* startupDiagnostics.measure(
            "runtime-recovery-acquire",
            acquireTarget(location, record.sessionId, !persisted),
          );
          yield* startupDiagnostics.measure(
            "runtime-recovery-replay",
            handle.recover(record.inputs, record.state === "stopped"),
          );
        }),
      ),
    );
    if (recovered._tag === "Failure") {
      yield* storage.update({
        ...record,
        state: record.state === "stopped" ? "stopped" : "blocked",
        issue: String(recovered.failure),
      });
      yield* Effect.logWarning(
        "Session restart recovery needs attention",
        record.sessionId,
        recovered.failure,
      );
    }
  }
});
