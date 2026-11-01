import { Schema } from "effect";
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

export class MemorySummaryError extends Schema.TaggedError<MemorySummaryError>()(
  "MemorySummaryError",
  { reason: Schema.Literals(["completion-failed", "empty-summary"]) },
) {}

/** Catch-up has no wall-clock or call-count deadline. Its lifecycle owner cancels
 * on Stop, foreground preemption or closure; successful nodes commit independently.
 * A completion failure is per node: the index stores a verbatim excerpt instead,
 * so one unsummarizable message can never stall memory or wedge the chat. */
export function memoryWork(signal: AbortSignal) {
  let calls = 0;
  const started = Date.now();
  return {
    signal,
    metrics: () => ({ calls, elapsedMs: Date.now() - started }),
    async complete(operation: (signal: AbortSignal) => Promise<string>) {
      signal.throwIfAborted();
      calls += 1;
      // Release the serialized owner even if an external callback ignores cancellation.
      // The abandoned callback cannot commit nodes: only synchronize owns persistence.
      try {
        const result = await abortableMemoryTask(operation(signal), signal);
        signal.throwIfAborted();
        return result;
      } catch {
        signal.throwIfAborted();
        throw new MemorySummaryError({ reason: "completion-failed" });
      }
    },
  };
}
export type MemoryWork = ReturnType<typeof memoryWork>;
