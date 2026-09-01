import { Effect } from "effect";
import type { PrivilegedRequest } from "../ipc/privileged-contract";
import { PrivilegedCapabilities } from "../services/privileged/PrivilegedCapabilities";

/** Requests one validated outside-world operation for a renderer connection. */
export const invoke = Effect.fn("Privileged.invoke")(function* (
  connectionId: number,
  request: PrivilegedRequest,
) {
  const capabilities = yield* PrivilegedCapabilities;
  return yield* capabilities.invoke(connectionId, request);
});

/** Observes scoped outside-world events addressed to one renderer connection. */
export const observe = Effect.fn("Privileged.observe")(function* (connectionId: number) {
  const capabilities = yield* PrivilegedCapabilities;
  return capabilities.observe(connectionId);
});
