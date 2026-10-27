import { createHash } from "node:crypto";

/** Join SDK execution and gateway diagnostics without emitting raw SDK call identities. */
export const cakeToolCallKey = (toolCallId: string) =>
  createHash("sha256").update(toolCallId).digest("hex").slice(0, 16);

/**
 * Reuse the SDK's monotonic execute-only measurement, not event arrival time.
 * This overlaps (never adds to) gateway phases. Result timestamps are later
 * publication/commit times and cannot truthfully reconstruct execution starts.
 */
export function reportSlowCakeToolExecution(
  runtime: "pi" | "durable",
  execution: {
    toolName: string;
    toolCallId: string;
    durationMs?: number;
    isError: boolean;
  },
): void {
  if (
    execution.toolName !== "cake" ||
    execution.durationMs === undefined ||
    execution.durationMs < 1_000
  )
    return;
  // Fixed metadata only: never arguments, result/error text, paths or raw IDs.
  console.warn("Slow Cake tool execution", {
    runtime,
    boundary: "sdk-execute",
    call: cakeToolCallKey(execution.toolCallId),
    durationMs: execution.durationMs,
    isError: execution.isError,
    unmeasured: [
      "model-generation",
      "sdk-admission",
      "environment-acquisition",
      "result-settlement-delivery",
    ],
  });
}
