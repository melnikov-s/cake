import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { SubagentHandleId } from "../../contracts/subagents/subagent-data";
import { SubagentError } from "../../contracts/subagents/subagent-data";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import {
  SubagentCoordinator,
  removeHandle,
  type SubagentCoordinatorState,
  type SubagentHandleState,
} from "../../services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import type { SubagentHistory } from "../../services/storage/SubagentStorage";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { asSubagentError as asError } from "./subagent-error-message";
import { checkpoint, mutateHandle, requireHandle } from "./subagentHandleState";
import { jsonValue, failHandle } from "./subagentCompletion";

const abortDirectChildren = Effect.fn("Subagents.abortDirectChildren")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  const children = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) =>
      handle.parentSessionId === parentSessionId &&
      (handle.status === "queued" || handle.status === "running"),
  );
  yield* Effect.forEach(
    children,
    (child) =>
      mutateHandle(child.handleId, (current) => ({
        ...current,
        status: "aborted",
        streaming: false,
      })).pipe(
        Effect.andThen(
          child.piHandle
            ? child.piHandle.abort().pipe(asError("abort"), Effect.asVoid)
            : FiberMap.remove(coordinator.fibers, child.handleId),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );
});

const releaseDirectChildren = Effect.fn("Subagents.releaseDirectChildren")(function* (
  parentSessionId: string,
): Effect.fn.Return<void, SubagentError, SubagentCoordinator | CakeSessionRuntimes> {
  const coordinator = yield* SubagentCoordinator;
  const children = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) => handle.parentSessionId === parentSessionId,
  );
  yield* Effect.forEach(children, (child) => releaseHandle(child), {
    concurrency: "unbounded",
    discard: true,
  });
});

export const abort = Effect.fn("Subagents.abort")(function* (
  parentSessionId: string,
  rawHandleId: string,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  if (handle.status !== "queued" && handle.status !== "running") return;
  const coordinator = yield* SubagentCoordinator;
  if (handle.privateSessionId) yield* abortDirectChildren(handle.privateSessionId);
  yield* mutateHandle(handle.handleId, (current) => ({
    ...current,
    status: "aborted",
    streaming: false,
  }));
  yield* checkpoint(handle.handleId);
  if (handle.status === "queued" || !handle.piHandle) {
    yield* FiberMap.remove(coordinator.fibers, handle.handleId);
    // A queued fiber can be interrupted before its supervisor begins. Complete
    // the handle independently, without waiting for the parent's notification turn.
    yield* FiberMap.run(
      coordinator.fibers,
      handle.handleId,
      failHandle(handle.handleId, Cause.interrupt()),
    );
  } else yield* handle.piHandle.abort().pipe(asError("abort"));
});

const releaseHandle = Effect.fn("Subagents.releaseHandle")(function* (
  handle: SubagentHandleState,
): Effect.fn.Return<void, SubagentError, SubagentCoordinator | CakeSessionRuntimes> {
  const coordinator = yield* SubagentCoordinator;
  if (handle.privateSessionId) yield* releaseDirectChildren(handle.privateSessionId);
  if (handle.piHandle) yield* handle.piHandle.abort().pipe(asError("close"));
  yield* Deferred.fail(
    handle.completion,
    new SubagentError({ operation: "close", message: "The subagent was closed" }),
  );
  yield* coordinator.checkpoints.withPermit(
    Effect.gen(function* () {
      // Commit the permanent identity before dropping any recovery/capability evidence.
      const current =
        (yield* SubscriptionRef.get(coordinator.state)).handles.get(handle.handleId) ?? handle;
      const history: SubagentHistory = {
        handleId: current.handleId,
        privateSessionId: current.recovery.privateSessionId,
        parentSessionId: current.parentSessionId,
        parentWorkingDirectory: current.recovery.parentWorkingDirectory,
        anchorPartId: current.anchorPartId,
        workingDirectory: current.runtimeOptions.runtime.cwd,
        sessionDirectory: current.runtimeOptions.runtime.sessionDir,
        task: current.task,
        status:
          current.status === "queued" || current.status === "running" ? "aborted" : current.status,
        resolvedModel: current.resolvedModel,
        fastMode: current.fastMode,
      };
      if (current.projectPath) Object.assign(history, { projectPath: current.projectPath });
      if (current.error !== undefined) Object.assign(history, { error: current.error });
      if (current.failurePhase !== undefined)
        Object.assign(history, { failurePhase: current.failurePhase });
      yield* coordinator.storage.history.update(history);
      yield* coordinator.storage.remove(handle.handleId);
      yield* SubscriptionRef.update(coordinator.state, (state) => ({
        ...removeHandle(state, handle.handleId),
        revision: state.revision + 1,
      }));
    }),
  );
  yield* FiberMap.remove(coordinator.fibers, handle.handleId);
  yield* Scope.close(handle.scope, Exit.void);
  yield* (yield* CakeSessionRuntimes)
    .forgetRecovery(handle.recovery.privateSessionId)
    .pipe(asError("close"));
});

export const close = Effect.fn("Subagents.close")(function* (
  parentSessionId: string,
  rawHandleId: string,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId, false);
  yield* releaseHandle(handle);
  return jsonValue({ handleId: handle.handleId, closed: true });
});

/** A worker is busy while a turn is queued/running or its completion is still being delivered. */
const turnActive = (handle: SubagentHandleState) =>
  handle.status === "queued" ||
  handle.status === "running" ||
  handle.completionDisposition === "notifying";

/**
 * Releases an expired worker only once it has no active turn. The idle check and removal are
 * one atomic state transition, so a follow-up cannot be claimed and then torn down mid-turn.
 */
export const expireWhenIdle = Effect.fn("Subagents.expireWhenIdle")(function* (
  handleId: SubagentHandleId,
) {
  const coordinator = yield* SubagentCoordinator;
  type Claim = "busy" | "gone" | SubagentHandleState;
  const claimIdle = SubscriptionRef.modify(
    coordinator.state,
    (state): readonly [Claim, SubagentCoordinatorState] => {
      const current = state.handles.get(handleId);
      if (!current) return ["gone", state];
      if (turnActive(current)) return ["busy", state];
      return [current, removeHandle(state, handleId)];
    },
  );
  const claimed = yield* SubscriptionRef.changes(coordinator.state).pipe(
    Stream.filter((state) => {
      const current = state.handles.get(handleId);
      return current === undefined || !turnActive(current);
    }),
    Stream.mapEffect(() => claimIdle),
    Stream.filter((claim) => claim !== "busy"),
    Stream.runHead,
  );
  if (Option.isSome(claimed) && claimed.value !== "gone") yield* releaseHandle(claimed.value);
});

export const abortParentChildren = Effect.fn("Subagents.abortParentChildren")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  const handles = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) =>
      handle.parentSessionId === parentSessionId &&
      (handle.status === "queued" || handle.status === "running"),
  );
  yield* Effect.forEach(handles, (handle) => abort(parentSessionId, handle.handleId), {
    concurrency: "unbounded",
    discard: true,
  });
});

export const releaseParent = Effect.fn("Subagents.releaseParent")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  const handles = [...(yield* SubscriptionRef.get(coordinator.state)).handles.values()].filter(
    (handle) => handle.parentSessionId === parentSessionId,
  );
  yield* Effect.forEach(handles, (handle) => close(parentSessionId, handle.handleId), {
    concurrency: "unbounded",
    discard: true,
  });
});

/** Explicit ownership traversal only. Resolution/release never calls this operation. */
export const deleteOwned = Effect.fn("Subagents.deleteOwned")(function* (parentSessionId: string) {
  const coordinator = yield* SubagentCoordinator;
  const sessions = yield* CakeSessionRuntimes;
  const archive = yield* SessionArchiveStorage;
  const environment = yield* SubagentEnvironment;
  const visited = new Set<string>([parentSessionId]);
  const removeChildren = Effect.fn("Subagents.deleteOwnedChildren")(function* (
    parentId: string,
  ): Effect.fn.Return<void, SubagentError, SubagentCoordinator | CakeSessionRuntimes> {
    yield* releaseParent(parentId);
    // Include recovery records that could not be restored (unavailable parent, etc.).
    const owned = new Map(
      (yield* coordinator.storage.history.list())
        .filter((record) => record.parentSessionId === parentId)
        .map((record) => [record.handleId, record] as const),
    );
    for (const record of yield* coordinator.storage.list()) {
      if (record.parentSessionId !== parentId || owned.has(record.handleId)) continue;
      const sessionDirectory =
        record.privateSessionDirectory ??
        (yield* environment.location(record.workingDirectory).pipe(asError("deleteOwned")))
          .sessionDirectory;
      owned.set(record.handleId, { ...record, sessionDirectory });
    }
    for (const record of owned.values()) {
      if (visited.has(record.privateSessionId))
        return yield* new SubagentError({
          operation: "deleteOwned",
          message: "Invalid cyclic private-worker ownership; no identity was guessed.",
        });
      visited.add(record.privateSessionId);
      yield* removeChildren(record.privateSessionId);
      yield* archive
        .deleteAuxiliary(record.privateSessionId, {
          cwd: record.workingDirectory,
          activeRoot: record.sessionDirectory,
        })
        .pipe(asError("deleteOwned"));
      yield* sessions.forgetRecovery(record.privateSessionId).pipe(asError("deleteOwned"));
      yield* coordinator.storage.remove(record.handleId);
      yield* coordinator.storage.history.remove(record.handleId);
    }
  });
  yield* removeChildren(parentSessionId);
});
