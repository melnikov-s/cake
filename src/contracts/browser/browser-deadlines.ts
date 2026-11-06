import { Schema } from "effect";

/** Native CDP includes screenshots and page evaluation; never retry on expiry. */
export const BROWSER_CDP_TIMEOUT_MS = 30_000;
/** Navigation may include DNS, TLS and redirects. */
export const BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;
/** Explicit finite budget for deliberate long CDP evaluations/waits. */
export const browserCdpTimeoutSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 600_000 }),
);

/** Leave time for desktop RPC delivery after the native deadline. */
export function browserRequestTimeoutMs(request: {
  readonly operation: "enter" | "cdp" | "events";
  readonly timeoutMs?: number;
}) {
  if (request.operation === "enter") return BROWSER_NAVIGATION_TIMEOUT_MS + 5_000;
  if (request.operation === "cdp") return (request.timeoutMs ?? BROWSER_CDP_TIMEOUT_MS) + 5_000;
  return 15_000;
}
