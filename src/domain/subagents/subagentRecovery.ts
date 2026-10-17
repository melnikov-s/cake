import { Deferred, Effect } from "effect";
import { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import { cakeChatControlTools } from "../../contracts/application/window-control-definitions";
import { locations } from "../project-sessions/projectSessionLocations";
import { acquireOptions as projectOptions } from "../project-sessions/projectSessionRuntime";
import { acquireOptions as chatOptions } from "../cake-chats/cakeChatRuntime";
import { makeSubagentParent, type SubagentControlRequirements } from "./subagentControl";
import { restore } from "./subagents";

/** Restore capabilities/handles before parent continuations can refer to them. Opening a parent
 * for configuration does not submit work or wake an idle conversation. */
export const initialize = Effect.fn("SubagentRecovery.initialize")(function* () {
  const coordinator = yield* SubagentCoordinator;
  const activated = yield* Deferred.make<void>();
  const recovery = yield* RuntimeRecoveryStorage;
  const availableLocations = yield* locations();
  const context = yield* Effect.context<SubagentControlRequirements>();
  const run = makePiCallbackExecutor(context);
  for (const record of yield* coordinator.storage.list()) {
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const options =
          record.parentProfile === "CakeChatSession"
            ? yield* chatOptions({
                configuration: yield* CakeChatConfiguration,
                target: { sessionId: record.parentSessionId, tools: cakeChatControlTools() },
                newSession: false,
              })
            : yield* Effect.gen(function* () {
                const location = availableLocations.find(
                  (item) =>
                    item.workingDirectory === record.parentWorkingDirectory &&
                    item.sessionDirectory === record.parentSessionDirectory,
                );
                if (!location)
                  return yield* Effect.fail(
                    new Error("The private worker's parent Working Directory is unavailable"),
                  );
                return yield* projectOptions({
                  location,
                  sessionId: record.parentSessionId,
                  newSession: false,
                });
              });
        const parent = makeSubagentParent(
          options,
          record.parentSessionId,
          record.parentWorkingDirectory,
          (effect, signal) => run(effect, { signal }),
        );
        const intent = yield* recovery.get(record.privateSessionId);
        yield* restore(
          record,
          parent,
          intent?.transcriptPersisted === true ||
            (record.status !== "queued" && record.status !== "running"),
          Deferred.await(activated),
        );
      }),
    );
    if (result._tag === "Failure") {
      // Retain the record for a future retry after the unavailable dependency is restored.
      yield* Effect.logWarning(
        "Private worker restart recovery needs attention",
        record.handleId,
        result.failure,
      );
    }
  }
  return Deferred.succeed(activated, undefined).pipe(Effect.asVoid);
});
