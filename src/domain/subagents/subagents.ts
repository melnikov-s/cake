import { Deferred, Effect, Exit, Fiber, Ref, Schema, Stream, SubscriptionRef } from "effect";
import type { SubagentHandleId, SubagentTaskInput } from "../../contracts/subagents/subagent-data";
import {
  ParallelSubagentInput,
  SubagentError,
  type SubagentTask,
} from "../../contracts/subagents/subagent-data";
import {
  SubagentCoordinator,
  activityOf,
  updateHandle,
  type SubagentHandleState,
} from "../../services/subagents/SubagentCoordinator";
import { subagentErrorMessage } from "./subagent-error-message";
import type { SubagentRecord } from "../../services/storage/SubagentStorage";
import { type SubagentParentRuntime, prepareTasks } from "./subagentTaskPreparation";
import { requireHandle } from "./subagentHandleState";
import { jsonValue, parentResult, deliverCompletion } from "./subagentCompletion";
import { startPrepared } from "./subagentExecution";
import { close } from "./subagentLifetime";

/** Rebuild a private capability scope with the same handle and Pi identity, never a fresh assignment. */
export const restore = Effect.fn("Subagents.restore")(function* (
  record: SubagentRecord,
  parent: SubagentParentRuntime,
  transcriptExpected: boolean,
  activate: Effect.Effect<void> = Effect.void,
) {
  const coordinator = yield* SubagentCoordinator;
  if ((yield* SubscriptionRef.get(coordinator.state)).handles.has(record.handleId)) return;
  const input: SubagentTask = {
    task: record.task,
    continuation: record.continuation ?? "none",
    model: {
      prefer: "exact",
      provider: record.resolvedModel.provider,
      modelId: record.resolvedModel.modelId,
      thinkingLevel: record.resolvedModel.thinkingLevel,
    },
    fastMode: record.fastMode,
    ...(record.preset ? { preset: record.preset } : null),
    allowMutations: record.allowMutations,
    ...(record.instructions === undefined ? null : { instructions: record.instructions }),
    ...(record.projectPath === undefined ? null : { projectPath: record.projectPath }),
  };
  yield* startPrepared(
    {
      input,
      parent,
      workingDirectory: record.workingDirectory,
      resolvedModel: record.resolvedModel,
      tools: record.tools,
    },
    record.anchorPartId,
    record.notifyOnCompletion,
    record,
    transcriptExpected,
    activate,
  );
});

export const start = Effect.fn("Subagents.start")(function* (
  input: SubagentTaskInput,
  parent: SubagentParentRuntime,
  anchorPartId = `subagent-${crypto.randomUUID()}`,
) {
  const [prepared] = yield* prepareTasks([input], parent);
  if (!prepared)
    return yield* new SubagentError({ operation: "start", message: "Task preflight failed" });
  return (yield* startPrepared(prepared, anchorPartId, true)).receipt;
});

export const run = Effect.fn("Subagents.run")(function* (
  input: SubagentTaskInput,
  parent: SubagentParentRuntime,
  onUpdate?: (value: Schema.Schema.Type<typeof Schema.Json>) => void,
  anchorPartId = `subagent-${crypto.randomUUID()}`,
) {
  const [prepared] = yield* prepareTasks([input], parent);
  if (!prepared)
    return yield* new SubagentError({ operation: "run", message: "Task preflight failed" });
  const started = yield* startPrepared(prepared, anchorPartId, false);
  return yield* wait(parent.parentSessionId, started.handleId, onUpdate).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.gen(function* () {
            const coordinator = yield* SubagentCoordinator;
            if (!(yield* Ref.get(coordinator.shuttingDown)))
              yield* close(parent.parentSessionId, started.handleId).pipe(Effect.ignore);
          })
        : Effect.void,
    ),
  );
});

export const parallel = Effect.fn("Subagents.parallel")(function* (
  input: ParallelSubagentInput,
  parent: SubagentParentRuntime,
  onUpdate?: (value: Schema.Schema.Type<typeof Schema.Json>) => void,
  anchorPartId = `subagent-${crypto.randomUUID()}`,
) {
  const parsed = yield* Schema.decodeUnknownEffect(ParallelSubagentInput)(input).pipe(
    Effect.mapError(
      (error) => new SubagentError({ operation: "parallel", message: subagentErrorMessage(error) }),
    ),
  );
  const prepared = yield* prepareTasks(parsed.tasks, parent);
  const coordinator = yield* SubagentCoordinator;
  const started: Array<SubagentHandleId> = [];
  const execute = Effect.gen(function* () {
    for (const task of prepared) {
      const handle = yield* startPrepared(task, anchorPartId, false);
      started.push(handle.handleId);
    }
    const results = yield* Effect.forEach(
      started,
      (handleId) =>
        wait(parent.parentSessionId, handleId, (latest) =>
          onUpdate?.(
            jsonValue({
              mode: "parallel",
              completed: started.filter(
                (id) => SubscriptionRef.getUnsafe(coordinator.state).handles.get(id)?.result,
              ).length,
              total: started.length,
              latest,
            }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return jsonValue({
      mode: "parallel",
      completed: results.length,
      total: results.length,
      results,
    });
  });
  return yield* execute.pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.gen(function* () {
            if (yield* Ref.get(coordinator.shuttingDown)) return;
            yield* Effect.forEach(started, (handleId) => close(parent.parentSessionId, handleId), {
              concurrency: "unbounded",
              discard: true,
            });
          })
        : Effect.void,
    ),
  );
});

export const wait = Effect.fn("Subagents.wait")(function* (
  parentSessionId: string,
  rawHandleId: string,
  onUpdate?: (value: Schema.Schema.Type<typeof Schema.Json>) => void,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  const coordinator = yield* SubagentCoordinator;
  const registered = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.handles.get(handle.handleId);
    if (!current || current.result || current.completionDisposition !== "pending")
      return [false, state] as const;
    return [
      true,
      updateHandle(state, handle.handleId, (value) => ({
        ...value,
        waiters: value.waiters + 1,
      })),
    ] as const;
  });
  const parentActivity = (value: SubagentHandleState) => {
    const activity = activityOf(value);
    return value.recovery.parentProfile === "CakeChatSession"
      ? { ...activity, parts: [] }
      : activity;
  };
  onUpdate?.(jsonValue(parentActivity(handle)));
  const observer = onUpdate
    ? yield* SubscriptionRef.changes(coordinator.state).pipe(
        Stream.map((state) => state.handles.get(handle.handleId)),
        Stream.filter((value): value is SubagentHandleState => value !== undefined),
        Stream.debounce("150 millis"),
        Stream.runForEach((value) => Effect.sync(() => onUpdate(jsonValue(parentActivity(value))))),
        Effect.forkChild,
      )
    : undefined;
  const completed = yield* Deferred.await(handle.completion).pipe(
    Effect.onExit((exit) =>
      registered
        ? SubscriptionRef.modify(coordinator.state, (state) => {
            const current = state.handles.get(handle.handleId);
            if (!current) return [false, state] as const;
            const waiters = Math.max(0, current.waiters - 1);
            const notify =
              Exit.isFailure(exit) &&
              waiters === 0 &&
              current.result !== undefined &&
              current.completionDisposition === "waited";
            return [
              notify,
              updateHandle(state, handle.handleId, (value) => ({
                ...value,
                waiters,
                completionDisposition: notify ? "notifying" : value.completionDisposition,
              })),
            ] as const;
          }).pipe(
            Effect.flatMap((notify) => (notify ? deliverCompletion(handle.handleId) : Effect.void)),
          )
        : Effect.void,
    ),
  );
  if (observer) yield* Fiber.interrupt(observer);
  return jsonValue(parentResult(handle, completed));
});
