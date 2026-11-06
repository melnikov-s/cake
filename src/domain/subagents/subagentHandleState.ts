import { Effect, Ref, Schema, Struct, SubscriptionRef } from "effect";
import { SubagentError, SubagentHandleId } from "../../contracts/subagents/subagent-data";
import {
  SubagentCoordinator,
  updateHandle,
  type SubagentHandleState,
} from "../../services/subagents/SubagentCoordinator";

export const mutateHandle = Effect.fn("Subagents.mutateHandle")(function* (
  handleId: SubagentHandleId,
  update: (handle: SubagentHandleState) => SubagentHandleState,
) {
  const coordinator = yield* SubagentCoordinator;
  yield* SubscriptionRef.update(coordinator.state, (state) =>
    updateHandle(state, handleId, (handle) => {
      const next = update(handle);
      return next === handle ? handle : { ...next, activityRevision: handle.activityRevision + 1 };
    }),
  );
});

export const checkpoint = Effect.fn("Subagents.checkpoint")(function* (handleId: SubagentHandleId) {
  const coordinator = yield* SubagentCoordinator;
  yield* coordinator.checkpoints.withPermit(
    Effect.gen(function* () {
      if (yield* Ref.get(coordinator.shuttingDown)) return;
      const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
      if (!handle) return;
      const record = Struct.omit(handle.recovery, ["error", "failurePhase"]);
      yield* coordinator.storage.update({
        ...record,
        status: handle.status,
        completionDisposition: handle.completionDisposition,
        inputReferences: handle.inputReferences,
        messageReferences: handle.messageReferences,
        ...(handle.error === undefined ? null : { error: handle.error }),
        ...(handle.failurePhase === undefined ? null : { failurePhase: handle.failurePhase }),
      });
    }),
  );
});

export const requireHandle = Effect.fn("Subagents.requireHandle")(function* (
  parentSessionId: string,
  handleId: string,
  hydrate = true,
) {
  const decoded = yield* Schema.decodeUnknownEffect(SubagentHandleId)(handleId).pipe(
    Effect.mapError(
      () => new SubagentError({ operation: "handle", message: "That subagent handle is invalid" }),
    ),
  );
  const coordinator = yield* SubagentCoordinator;
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(decoded);
  const released = yield* coordinator.storage.history.get(decoded);
  if (released?.parentSessionId === parentSessionId)
    return yield* new SubagentError({
      operation: "handle",
      message: "This subagent has been released. Its saved conversation is read-only.",
    });
  if (!handle) {
    // A failed startup preflight retains saved handles instead of pretending
    // they never existed. Surface storage repair evidence to the caller too.
    const saved = yield* coordinator.storage.get(decoded);
    if (saved?.parentSessionId === parentSessionId)
      return yield* new SubagentError({
        operation: "handle",
        message:
          "This saved worker has not been restored. Repair the recovery metadata reported at startup and restart Cake before using this handle.",
      });
  }
  if (!handle || handle.parentSessionId !== parentSessionId)
    return yield* new SubagentError({
      operation: "handle",
      message: "That subagent handle does not belong to this parent session",
    });
  if (hydrate && handle.hydrate) {
    yield* handle.hydrate;
    return (yield* SubscriptionRef.get(coordinator.state)).handles.get(decoded) ?? handle;
  }
  return handle;
});

export const requireHandleById = Effect.fn("Subagents.requireHandleById")(function* (
  handleId: SubagentHandleId,
) {
  const coordinator = yield* SubagentCoordinator;
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
  if (!handle)
    return yield* new SubagentError({ operation: "handle", message: "That subagent is closed" });
  return handle;
});
