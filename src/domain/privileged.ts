import { Effect, type Schema } from "effect";
import { PrivilegedCapabilities } from "../services/privileged/PrivilegedCapabilities";

/** Requests one validated outside-world operation for a renderer connection. */
export const invoke = Effect.fn("Privileged.invoke")(function* (
  connectionId: number,
  request: Schema.Schema.Type<typeof Schema.Json>,
) {
  const capabilities = yield* PrivilegedCapabilities;
  return yield* capabilities.invoke(connectionId, request);
});

/** Observes scoped outside-world events addressed to one renderer connection. */
export const observe = Effect.fn("Privileged.observe")(function* (connectionId: number) {
  const capabilities = yield* PrivilegedCapabilities;
  return capabilities.observe(connectionId);
});
