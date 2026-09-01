import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import type { NativeEvent, NativeCommand, NativeCommandResult } from "../../ipc/native-contract";

export class NativeCapabilityError extends Schema.TaggedError<NativeCapabilityError>()(
  "NativeCapabilityError",
  { message: Schema.String },
) {}

export type NativeStreamElement = NativeEvent | { readonly type: "native-stream-ready" };

export interface NativeCapabilityOperations {
  readonly invoke: (connectionId: number, request: NativeCommand) => Promise<NativeCommandResult>;
  readonly subscribe: (connectionId: number, listener: (event: NativeEvent) => void) => () => void;
}

export class NativeCapabilities extends Context.Service<
  NativeCapabilities,
  {
    readonly invoke: (
      connectionId: number,
      request: NativeCommand,
    ) => Effect.Effect<NativeCommandResult, NativeCapabilityError>;
    readonly observe: (connectionId: number) => Stream.Stream<NativeStreamElement>;
  }
>()("cake/services/NativeCapabilities") {}

export const makeNativeCapabilitiesLive = (operations: NativeCapabilityOperations) =>
  Layer.succeed(NativeCapabilities, {
    invoke: Effect.fn("NativeCapabilities.invoke")((connectionId, request) =>
      Effect.tryPromise({
        try: () => operations.invoke(connectionId, request),
        catch: (error) =>
          new NativeCapabilityError({
            message: error instanceof Error ? error.message : String(error),
          }),
      }),
    ),
    observe: (connectionId) =>
      Stream.callback<NativeStreamElement>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const unsubscribe = operations.subscribe(connectionId, (event) => {
              Queue.offerUnsafe(queue, event);
            });
            Queue.offerUnsafe(queue, { type: "native-stream-ready" });
            return unsubscribe;
          }),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ),
  });
