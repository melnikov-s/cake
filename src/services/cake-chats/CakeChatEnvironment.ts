import { Context, Effect, Layer, Schema, type Stream } from "effect";
import type { JsonValue } from "../../ipc/json-contract";
import type { PiSessionAcquireOptions } from "../pi/PiSessions";
import type { CakeChatControlRequest, CakeControlTool } from "../../domain/cake-chat-data";
import {
  RendererRequestCoordinator,
  type RendererRequestCoordinatorError,
} from "../renderer-requests/RendererRequestCoordinator";

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
  readonly bindRenderer: (
    sessionId: string,
    connectionId: number,
  ) => Effect.Effect<void, CakeChatEnvironmentError>;
  readonly controlRequests: (connectionId?: number) => Stream.Stream<CakeChatControlRequest>;
  readonly respondControl: (
    connectionId: number,
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

/** Outside-world adapter for Cake Chat archive paths and renderer control settlement. */
export const makeCakeChatEnvironmentLayer = (operations: CakeChatEnvironmentOperations) =>
  Layer.effect(
    CakeChatEnvironment,
    Effect.gen(function* () {
      const rendererRequests = yield* RendererRequestCoordinator;

      const requestControl = Effect.fn("CakeChatEnvironment.requestControl")(
        (
          sessionId: string,
          invocation: { readonly name: string; readonly arguments: JsonValue },
          signal: AbortSignal,
        ) =>
          rendererRequests.requestCakeChatControl(sessionId, invocation, signal).pipe(Effect.orDie),
      );

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
        const runtime = yield* operations.runtimeOptions({ ...input, tools }, invoke);
        return {
          ...runtime,
          onRelease: (runtime.onRelease ?? Effect.void).pipe(
            Effect.ensuring(
              rendererRequests.releaseSession({
                _tag: "CakeChatSession",
                sessionId: input.sessionId,
              }),
            ),
          ),
        };
      });
      const respondControl = Effect.fn("CakeChatEnvironment.respondControl")(
        (connectionId: number, controlRequestId: string, result: JsonValue) =>
          rendererRequests.respondCakeChatControl(connectionId, controlRequestId, result).pipe(
            Effect.mapError(
              (error: RendererRequestCoordinatorError) =>
                new CakeChatEnvironmentError({
                  operation: error.operation,
                  message: error.message,
                }),
            ),
          ),
      );

      return CakeChatEnvironment.of({
        location: operations.location,
        runtimeOptions,
        bindRenderer: (sessionId, connectionId) =>
          rendererRequests.bind({ _tag: "CakeChatSession", sessionId }, connectionId).pipe(
            Effect.mapError(
              (error: RendererRequestCoordinatorError) =>
                new CakeChatEnvironmentError({
                  operation: error.operation,
                  message: error.message,
                }),
            ),
          ),
        controlRequests: rendererRequests.cakeChatControlRequests,
        respondControl,
        archive: operations.archive,
        restore: operations.restore,
        deleteResolved: operations.deleteResolved,
      });
    }),
  );
