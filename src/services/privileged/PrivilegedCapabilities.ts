import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import type {
  PrivilegedEvent,
  PrivilegedRequest,
  PrivilegedResponse,
} from "../../ipc/privileged-contract";

export class PrivilegedCapabilityError extends Schema.TaggedError<PrivilegedCapabilityError>()(
  "PrivilegedCapabilityError",
  { message: Schema.String },
) {}

export type PrivilegedStreamElement =
  | PrivilegedEvent
  | { readonly type: "privileged-stream-ready" };

export interface PrivilegedCapabilityOperations {
  readonly invoke: (
    connectionId: number,
    request: PrivilegedRequest,
  ) => Promise<PrivilegedResponse>;
  readonly subscribe: (
    connectionId: number,
    listener: (event: PrivilegedEvent) => void,
  ) => () => void;
}

export class PrivilegedCapabilities extends Context.Service<
  PrivilegedCapabilities,
  {
    readonly invoke: (
      connectionId: number,
      request: PrivilegedRequest,
    ) => Effect.Effect<PrivilegedResponse, PrivilegedCapabilityError>;
    readonly observe: (connectionId: number) => Stream.Stream<PrivilegedStreamElement>;
  }
>()("cake/services/PrivilegedCapabilities") {}

export const makePrivilegedCapabilitiesLive = (operations: PrivilegedCapabilityOperations) =>
  Layer.succeed(PrivilegedCapabilities, {
    invoke: Effect.fn("PrivilegedCapabilities.invoke")((connectionId, request) =>
      Effect.tryPromise({
        try: () => operations.invoke(connectionId, request),
        catch: (error) =>
          new PrivilegedCapabilityError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    ),
    observe: (connectionId) =>
      Stream.callback<PrivilegedStreamElement>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const unsubscribe = operations.subscribe(connectionId, (event) => {
              Queue.offerUnsafe(queue, event);
            });
            Queue.offerUnsafe(queue, { type: "privileged-stream-ready" });
            return unsubscribe;
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ),
  });
