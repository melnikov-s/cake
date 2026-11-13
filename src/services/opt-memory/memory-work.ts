import { Effect, Schedule, Schema } from "effect";
import {
  CompletionFailureCategory,
  PiModelCompletionError,
  UnauthenticatedPiModelError,
  UnknownPiModelError,
  UnavailablePiModelError,
  UnsupportedFastModeError,
  UnsupportedThinkingLevelError,
} from "../../contracts/pi/model-data";

/** The reusable core has no SDK context. Wait for either an adapter request or
 * its lifecycle cancellation, removing the listener when the request settles. */
export async function abortableMemoryTask<A>(task: Promise<A>, signal: AbortSignal): Promise<A> {
  signal.throwIfAborted();
  const result = Promise.withResolvers<A>();
  const abort = () => result.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  task.then(result.resolve, result.reject);
  try {
    return await result.promise;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export const MemoryFailureReason = Schema.Union([
  CompletionFailureCategory,
  Schema.Literals(["completion-skipped", "missing-original", "degraded-source"]),
]);
export class MemorySummaryError extends Schema.TaggedError<MemorySummaryError>()(
  "MemorySummaryError",
  { reason: MemoryFailureReason },
) {}

/** Deliberately discard bodies, messages and causes at the memory boundary. Unknown
 * errors are not evidence of transience. Resolution/auth failures need user action. */
const classify = (error: unknown): MemorySummaryError => {
  if (error instanceof MemorySummaryError) return error;
  if (error instanceof UnauthenticatedPiModelError)
    return new MemorySummaryError({ reason: "authentication" });
  if (
    error instanceof UnknownPiModelError ||
    error instanceof UnavailablePiModelError ||
    error instanceof UnsupportedFastModeError ||
    error instanceof UnsupportedThinkingLevelError
  )
    return new MemorySummaryError({ reason: "configuration" });
  return new MemorySummaryError({
    reason:
      error instanceof PiModelCompletionError
        ? (error.category ?? "completion-failed")
        : "completion-failed",
  });
};

/** Idempotent completion only. Two calls total, 250ms backoff, lifecycle-cancelled.
 * Length correction is a separate bounded conversation in the tree. */
export const retryMemoryCompletion = Effect.fn("Memory.complete")(
  (operation: (signal: AbortSignal) => Promise<string>) =>
    Effect.tryPromise({
      try: (signal) => abortableMemoryTask(operation(signal), signal),
      catch: classify,
    }).pipe(
      Effect.retry(
        Schedule.exponential("250 millis").pipe(
          Schedule.upTo({ times: 1 }),
          Schedule.setInputType<MemorySummaryError>(),
          Schedule.while(({ input }) => input.reason === "transient"),
        ),
      ),
    ),
);

/** One serialized indexing/repair pass. A permanent model failure opens a local
 * circuit for the rest of this pass; it never spins across the historical backlog. */
export function memoryWork(signal: AbortSignal) {
  let calls = 0;
  let blocked: MemorySummaryError | undefined;
  const started = Date.now();
  return {
    signal,
    metrics: () => ({ calls, elapsedMs: Date.now() - started }),
    async complete(operation: (signal: AbortSignal) => Promise<string>) {
      signal.throwIfAborted();
      if (blocked) throw blocked;
      try {
        return await Effect.runPromise(
          retryMemoryCompletion((callSignal) => {
            calls += 1;
            return operation(AbortSignal.any([signal, callSignal]));
          }),
          { signal },
        );
      } catch (error) {
        signal.throwIfAborted();
        const failure = classify(error);
        if (failure.reason === "configuration" || failure.reason === "authentication")
          blocked = failure;
        throw failure;
      }
    },
  };
}
export type MemoryWork = ReturnType<typeof memoryWork>;
