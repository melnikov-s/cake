import { Context, Deferred, Effect, Layer, PubSub, Schema, Stream } from "effect";
import type { JsonValue } from "../../ipc/json-contract";
import type { PiSessionAcquireOptions } from "../pi/PiSessions";
import type { CakeChatControlRequest, CakeControlTool } from "../../domain/cake-chat-data";

interface CakeChatLocation {
  readonly workingDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
}

export interface CakeChatRuntimeInput {
  readonly sessionId: string;
  readonly newSession: boolean;
  readonly tools: ReadonlyArray<CakeControlTool>;
}

export class CakeChatEnvironmentError extends Schema.TaggedError<CakeChatEnvironmentError>()(
  "CakeChatEnvironmentError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface CakeChatEnvironmentService {
  readonly location: () => Effect.Effect<CakeChatLocation, CakeChatEnvironmentError>;
  readonly runtimeOptions: (
    input: CakeChatRuntimeInput,
  ) => Effect.Effect<PiSessionAcquireOptions, CakeChatEnvironmentError>;
  readonly controlRequests: () => Stream.Stream<CakeChatControlRequest>;
  readonly respondControl: (
    controlRequestId: string,
    result: JsonValue,
  ) => Effect.Effect<void, CakeChatEnvironmentError>;
  readonly archive: (sessionId: string) => Effect.Effect<void, CakeChatEnvironmentError>;
  readonly restore: (sessionId: string) => Effect.Effect<void, CakeChatEnvironmentError>;
  readonly deleteResolved: (sessionId: string) => Effect.Effect<void, CakeChatEnvironmentError>;
}

export class CakeChatEnvironment extends Context.Service<
  CakeChatEnvironment,
  CakeChatEnvironmentService
>()("cake/services/cake-chats/CakeChatEnvironment") {}

export interface CakeChatEnvironmentOperations {
  readonly location: () => Effect.Effect<CakeChatLocation, CakeChatEnvironmentError>;
  readonly runtimeOptions: (
    input: CakeChatRuntimeInput,
    invoke: (
      sessionId: string,
      input: { readonly name: string; readonly arguments: JsonValue },
      signal: AbortSignal,
    ) => Effect.Effect<JsonValue>,
  ) => Effect.Effect<PiSessionAcquireOptions, CakeChatEnvironmentError>;
  readonly archive: (sessionId: string) => Effect.Effect<void, CakeChatEnvironmentError>;
  readonly restore: (sessionId: string) => Effect.Effect<void, CakeChatEnvironmentError>;
  readonly deleteResolved: (sessionId: string) => Effect.Effect<void, CakeChatEnvironmentError>;
}

const cancelledControl = (name: string): JsonValue => ({
  ok: false,
  name,
  error: "The Cake Chat request was cancelled.",
});

/** Outside-world adapter for Cake Chat archive paths and renderer control settlement. */
export const makeCakeChatEnvironmentLayer = (operations: CakeChatEnvironmentOperations) =>
  Layer.effect(
    CakeChatEnvironment,
    Effect.gen(function* () {
      const requests = yield* PubSub.unbounded<CakeChatControlRequest>();
      const pending = new Map<string, Deferred.Deferred<JsonValue>>();

      const requestControl = Effect.fn("CakeChatEnvironment.requestControl")(function* (
        sessionId: string,
        invocation: { readonly name: string; readonly arguments: JsonValue },
        signal: AbortSignal,
      ) {
        const controlRequestId = crypto.randomUUID();
        const response = yield* Deferred.make<JsonValue>();
        pending.set(controlRequestId, response);
        yield* PubSub.publish(requests, {
          _tag: "ControlRequested",
          sessionId,
          controlRequestId,
          invocation,
        });
        const aborted = Effect.callback<JsonValue>((resume) => {
          const onAbort = () => resume(Effect.succeed(cancelledControl(invocation.name)));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", onAbort));
        });
        return yield* Effect.race(Deferred.await(response), aborted).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(controlRequestId))),
        );
      });

      const invoke = (
        sessionId: string,
        invocation: { readonly name: string; readonly arguments: JsonValue },
        signal: AbortSignal,
      ) => requestControl(sessionId, invocation, signal);

      const toolsBySessionId = new Map<string, ReadonlyArray<CakeControlTool>>();
      const runtimeOptions = Effect.fn("CakeChatEnvironment.runtimeOptions")(function* (
        input: CakeChatRuntimeInput,
      ) {
        if (input.tools.length > 0) toolsBySessionId.set(input.sessionId, input.tools);
        const tools =
          input.tools.length > 0 ? input.tools : (toolsBySessionId.get(input.sessionId) ?? []);
        return yield* operations.runtimeOptions({ ...input, tools }, invoke);
      });
      const respondControl = Effect.fn("CakeChatEnvironment.respondControl")(function* (
        controlRequestId: string,
        result: JsonValue,
      ) {
        const response = pending.get(controlRequestId);
        if (!response)
          return yield* new CakeChatEnvironmentError({
            operation: "respondControl",
            message: "That Cake Chat control request is no longer pending",
          });
        yield* Deferred.succeed(response, result);
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const response of pending.values())
            yield* Deferred.succeed(response, { ok: false, error: "Cake Chat stopped." });
          pending.clear();
          yield* PubSub.shutdown(requests);
        }),
      );

      return CakeChatEnvironment.of({
        location: operations.location,
        runtimeOptions,
        controlRequests: () => Stream.fromPubSub(requests),
        respondControl,
        archive: operations.archive,
        restore: operations.restore,
        deleteResolved: operations.deleteResolved,
      });
    }),
  );
