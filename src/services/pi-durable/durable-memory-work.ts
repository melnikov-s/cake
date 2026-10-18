import { Schema } from "effect";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";

// SDK-boundary budgets include queue wait, storage/model resolution and every completion.
// A completion gets at most 20s, and never more than the enclosing work allowance.
// Counts bound application invocations, not transport attempts internal to a provider.
export class DurableMemoryError extends Schema.TaggedError<DurableMemoryError>()(
  "DurableMemoryError",
  {
    reason: Schema.Literals([
      "work-allowance",
      "completion-failed",
      "completion-allowance",
      "empty-summary",
      "oversized-summary",
    ]),
  },
) {}

export const MEMORY_CALL_MS = 20_000;
export const MEMORY_FOREGROUND_WORK = { milliseconds: 60_000, calls: 32 };
export const MEMORY_BACKGROUND_WORK = { milliseconds: 30_000, calls: 16 };

export function durableMemoryWork(parent: AbortSignal, limits = MEMORY_FOREGROUND_WORK) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(limits.milliseconds)]);
  let calls = 0;
  const started = Date.now();
  return {
    signal,
    metrics: () => ({ calls, elapsedMs: Date.now() - started }),
    async complete(operation: (signal: AbortSignal) => Promise<string>) {
      signal.throwIfAborted();
      if (calls >= limits.calls) throw new DurableMemoryError({ reason: "work-allowance" });
      calls += 1;
      const callSignal = AbortSignal.any([signal, AbortSignal.timeout(MEMORY_CALL_MS)]);
      // Release the serialized owner even if an external callback ignores cancellation.
      // The abandoned callback cannot commit nodes: only synchronize owns persistence.
      try {
        const result = await awaitWithContext(
          operation(callSignal),
          withAbortSignal(callSignal, BACKGROUND_CONTEXT),
        );
        callSignal.throwIfAborted();
        return result;
      } catch {
        if (parent.aborted) throw parent.reason;
        throw new DurableMemoryError({
          reason: signal.aborted
            ? "work-allowance"
            : callSignal.aborted
              ? "completion-allowance"
              : "completion-failed",
        });
      }
    },
  };
}
export type DurableMemoryWork = ReturnType<typeof durableMemoryWork>;
