import { Effect, Stream, SubscriptionRef } from "effect";
import type { SubagentHandleId } from "../../contracts/subagents/subagent-data";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import { generateSessionTitle, utilityModelSelection } from "../utility-work/utilityWork";
import { checkpoint, mutateHandle } from "./subagentHandleState";

/** The title needs the gist of the task, not a full multi-page brief. */
export const SUBAGENT_TITLE_SOURCE_CHARACTERS = 2_000;
/** Parallel batches admit up to eight workers at once; name them a couple at a time. */
const TITLE_CONCURRENCY = 2;

const titleSource = (task: string) =>
  task.replace(/\s+/g, " ").trim().slice(0, SUBAGENT_TITLE_SOURCE_CHARACTERS);

/**
 * Names one worker with the session-naming utility model, once. A saved title is
 * never replaced; without a utility model the row keeps its task preview.
 */
export const assign = Effect.fn("SubagentTitles.assign")(function* (handleId: SubagentHandleId) {
  const utilityModel = (yield* ApplicationState).snapshot().utilityModel;
  if (!utilityModel) return;
  const coordinator = yield* SubagentCoordinator;
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
  if (!handle || handle.recovery.title) return;
  const firstUserMessage = titleSource(handle.task);
  if (!firstUserMessage) return;
  const title = yield* generateSessionTitle({
    selection: utilityModelSelection(utilityModel),
    firstUserMessage,
  });
  yield* mutateHandle(handleId, (current) =>
    current.recovery.title ? current : { ...current, recovery: { ...current.recovery, title } },
  );
  if ((yield* SubscriptionRef.get(coordinator.state)).handles.has(handleId)) {
    yield* checkpoint(handleId);
    return;
  }
  // Released while naming: label its history record instead (navigation still lists it).
  yield* coordinator.checkpoints.withPermit(
    Effect.gen(function* () {
      const history = yield* coordinator.storage.history.get(handleId);
      if (history && !history.title)
        yield* coordinator.storage.history.update({ ...history, title });
    }),
  );
});

export const initialize = Effect.fn("SubagentTitles.initialize")(function* () {
  const coordinator = yield* SubagentCoordinator;
  yield* Stream.fromQueue(coordinator.titleRequests).pipe(
    Stream.mapEffect(
      (handleId) =>
        assign(handleId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Subagent naming failed; keeping its task preview", error),
          ),
        ),
      { concurrency: TITLE_CONCURRENCY },
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );
});
