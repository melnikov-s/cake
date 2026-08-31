import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";

export class PrivilegedCapabilityError extends Schema.TaggedError<PrivilegedCapabilityError>()(
  "PrivilegedCapabilityError",
  { message: Schema.String },
) {}

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

export interface PrivilegedCapabilityOperations {
  readonly invoke: (connectionId: number, request: JsonValue) => Promise<JsonValue>;
  readonly subscribe: (connectionId: number, listener: (event: JsonValue) => void) => () => void;
}

export class PrivilegedCapabilities extends Context.Service<
  PrivilegedCapabilities,
  {
    readonly invoke: (
      connectionId: number,
      request: Schema.Schema.Type<typeof Schema.Json>,
    ) => Effect.Effect<Schema.Schema.Type<typeof Schema.Json>, PrivilegedCapabilityError>;
    readonly observe: (
      connectionId: number,
    ) => Stream.Stream<Schema.Schema.Type<typeof Schema.Json>>;
  }
>()("cake/services/PrivilegedCapabilities") {}

export const makePrivilegedCapabilitiesLive = (operations: PrivilegedCapabilityOperations) =>
  Layer.succeed(PrivilegedCapabilities, {
    invoke: Effect.fn("PrivilegedCapabilities.invoke")((connectionId, request) =>
      Effect.tryPromise({
        try: async () =>
          Schema.decodeUnknownSync(Schema.Json)(await operations.invoke(connectionId, request)),
        catch: (error) =>
          new PrivilegedCapabilityError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    ),
    observe: (connectionId) =>
      Stream.callback((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const unsubscribe = operations.subscribe(connectionId, (event) => {
              Queue.offerUnsafe(queue, Schema.decodeUnknownSync(Schema.Json)(event));
            });
            Queue.offerUnsafe(queue, { type: "privileged-stream-ready" });
            return unsubscribe;
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ),
  });
