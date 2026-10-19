import { Schema } from "effect";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";

export class DurableMemoryError extends Schema.TaggedError<DurableMemoryError>()(
  "DurableMemoryError",
  { reason: Schema.Literals(["completion-failed", "empty-summary"]) },
) {}

/** Catch-up has no wall-clock or call-count deadline. Its lifecycle owner cancels
 * on Stop, foreground preemption or closure; successful nodes commit independently. */
export function durableMemoryWork(signal: AbortSignal) {
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
        const result = await awaitWithContext(
          operation(signal),
          withAbortSignal(signal, BACKGROUND_CONTEXT),
        );
        signal.throwIfAborted();
        return result;
      } catch {
        signal.throwIfAborted();
        throw new DurableMemoryError({ reason: "completion-failed" });
      }
    },
  };
}
export type DurableMemoryWork = ReturnType<typeof durableMemoryWork>;
