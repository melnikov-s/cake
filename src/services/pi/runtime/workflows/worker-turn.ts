import { Clock, Deferred, Effect, Fiber, Queue, Ref, Stream, SubscriptionRef } from "effect";
import {
  WorkflowError,
  type WorkflowWorkerActivity,
} from "../../../../contracts/workflows/workflow-data";
import type { PiTurnResult } from "../../../../contracts/pi/turn-result-data";
import type { ConversationSnapshot, UiPart } from "../../../../ipc/session-contract";
import type { CakeSessionHandle } from "../../CakeSessionRuntimes";
import type { WorkflowWorkerRequest } from "../../WorkflowWorkers";

export const workerError = (operation: string) =>
  Effect.mapError((error: unknown) =>
    error instanceof WorkflowError
      ? error
      : new WorkflowError({
          operation,
          reason: "worker",
          message: error instanceof Error ? error.message : String(error),
        }),
  );

export const activityFromSnapshot = (
  request: Pick<WorkflowWorkerRequest, "target" | "attempt">,
  snapshot: Pick<ConversationSnapshot, "parts" | "streaming" | "usage">,
): WorkflowWorkerActivity => ({
  stepId: request.target.stepId,
  execution: request.target.execution,
  attempt: request.attempt,
  streaming: snapshot.streaming,
  parts: snapshot.parts.slice(-10_000),
  ...(snapshot.usage ? { usage: snapshot.usage } : undefined),
});

export interface WorkerSettlement {
  readonly turnId: string;
  readonly outcome: "complete" | "failed" | "aborted";
  readonly message?: string;
  readonly result?: PiTurnResult;
}

const waitingForTools = (parts: ReadonlyArray<UiPart>): boolean =>
  parts.some(
    (part) =>
      (part.kind === "tool" &&
        !part.inputStreaming &&
        (part.state === "running" || part.state === "approval")) ||
      (part.kind === "command" && part.state === "running"),
  );

/** One observer per turn. The Scope owns its timer/listener; Pi owns the actual turn. */
export const workerTurn = Effect.fn("WorkflowWorkers.turn")(function* (
  handle: CakeSessionHandle,
  request: WorkflowWorkerRequest,
  settlements: Queue.Queue<WorkerSettlement>,
  text: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const initial = yield* handle.snapshot().pipe(workerError("snapshot"));
      const activity = yield* Ref.make(activityFromSnapshot(request, initial));
      const clock = yield* SubscriptionRef.make({
        waiting: false,
        lastProgress: yield* Clock.currentTimeMillis,
      });
      const consume = handle.updates.pipe(
        Stream.runForEach((update) =>
          Effect.gen(function* () {
            let progress = false;
            if (update._tag === "Snapshot") {
              yield* Ref.set(activity, activityFromSnapshot(request, update.snapshot));
              yield* Deferred.succeed(ready, undefined);
            } else {
              const event = update.event;
              if (event.type === "snapshot-updated")
                yield* Ref.set(activity, activityFromSnapshot(request, event.snapshot));
              else if (event.type === "part-updated") {
                progress = true;
                yield* Ref.update(activity, (current) => {
                  const parts = [...current.parts];
                  const index = parts.findIndex((part) => part.id === event.part.id);
                  if (index < 0) parts.push(event.part);
                  else parts[index] = event.part;
                  return { ...current, parts: parts.slice(-10_000) };
                });
              } else if (event.type === "part-removed")
                yield* Ref.update(activity, (current) => ({
                  ...current,
                  parts: current.parts.filter((part) => part.id !== event.partId),
                }));
              else if (event.type === "streaming")
                yield* Ref.update(activity, (current) => ({
                  ...current,
                  streaming: event.streaming,
                }));
              else if (event.type === "usage-updated")
                yield* Ref.update(activity, (current) => ({ ...current, usage: event.usage }));
            }
            const current = yield* Ref.get(activity);
            const waiting = waitingForTools(current.parts);
            const previous = yield* SubscriptionRef.get(clock);
            if (progress || waiting !== previous.waiting)
              yield* SubscriptionRef.set(clock, {
                waiting,
                lastProgress: yield* Clock.currentTimeMillis,
              });
            yield* request.onActivity(current);
          }),
        ),
        workerError("observe"),
        // A lost observer is not a successful worker completion.
        Effect.andThen(
          Effect.fail(
            new WorkflowError({
              operation: "observe",
              reason: "worker",
              message: "Worker observation ended before its turn settled",
            }),
          ),
        ),
      );
      const observer = yield* consume.pipe(Effect.forkScoped);
      yield* Deferred.await(ready).pipe(Effect.raceFirst(Fiber.join(observer)));
      const stallMs = request.input.options.stallMs ?? 600_000;
      const stalled = SubscriptionRef.changes(clock).pipe(
        Stream.switchMap((state) =>
          state.waiting
            ? Stream.never
            : Stream.fromEffect(
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  yield* Effect.sleep(Math.max(0, state.lastProgress + stallMs - now));
                  return yield* new WorkflowError({
                    operation: "turn",
                    reason: "stalled",
                    message: `Worker made no progress for ${stallMs} ms, excluding tool waits`,
                  });
                }),
              ),
        ),
        Stream.runDrain,
        Effect.andThen(Effect.never),
      );
      const wait = Effect.gen(function* () {
        const turnId = yield* handle.prompt(text).pipe(workerError("prompt"));
        const settlement = yield* Queue.take(settlements);
        if (settlement.turnId !== turnId)
          return yield* new WorkflowError({
            operation: "turn",
            reason: "worker",
            message: "Unexpected worker turn settlement",
          });
        if (settlement.outcome !== "complete")
          return yield* new WorkflowError({
            operation: "turn",
            reason: "worker",
            message:
              settlement.message ??
              settlement.result?.errorMessage ??
              `Worker turn ${settlement.outcome}`,
          });
        const snapshot = yield* handle.snapshot().pipe(workerError("snapshot"));
        return { snapshot, answer: settlement.result?.text };
      });
      const final = yield* wait.pipe(
        Effect.raceFirst(stalled),
        Effect.raceFirst(Fiber.join(observer)),
      );
      yield* Fiber.interrupt(observer);
      yield* request.onActivity(activityFromSnapshot(request, final.snapshot));
      return final;
    }),
  );
});
