import { Deferred, Effect, Semaphore, Stream, SubscriptionRef } from "effect";
import type { InterviewRecord } from "../../contracts/interviews/interview";
import type { CakeChatControlRequest } from "../../contracts/cake-chats/cake-chat-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { ClientEvents } from "../clients/ClientEvents";
import { coordinatorError } from "./RendererRequestError";

export type SessionTarget =
  | { readonly _tag: "ProjectSession"; readonly sessionId: string }
  | { readonly _tag: "CakeChatSession"; readonly sessionId: string };

export type PendingRequest =
  | {
      readonly _tag: "WindowControl";
      readonly sessionId?: never;
      readonly connectionId: number;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "WindowStateFlush";
      readonly sessionId: "";
      readonly connectionId: number;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "Ui";
      readonly targetKind?: SessionTarget["_tag"];
      readonly workflowChoice: boolean;
      readonly title: string;
      readonly signal?: AbortSignal;
      readonly sessionId: string;
      readonly connectionId: number;
      readonly operationId: string;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "Interview";
      readonly record: InterviewRecord;
      readonly sessionId: string;
      readonly connectionId: number;
      readonly operationId: string;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "ProjectControl";
      readonly origin: "project-session" | "discussion-session";
      readonly sessionId: string;
      readonly connectionId: number;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "CakeChatControl";
      readonly sessionId: string;
      readonly connectionId: number;
      readonly name: string;
      readonly invocation: { readonly name: string; readonly arguments: JsonValue };
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "BrowserNative";
      readonly method?: string;
      readonly sessionId: string;
      readonly connectionId: number;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "WidgetCapture";
      readonly sessionId: string;
      readonly connectionId: number;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    };

const cancellationValue = (pending: PendingRequest, stopped: boolean): JsonValue | undefined => {
  if (pending._tag === "WindowControl")
    return {
      handled: true,
      result: { ok: false, error: "The window control request was cancelled." },
    };
  if (pending._tag === "WindowStateFlush")
    return "The window disconnected before saving its settings";
  if (pending._tag === "Ui" || pending._tag === "Interview") return undefined;
  if (pending._tag === "BrowserNative")
    return {
      status: "failed",
      message: stopped ? "The Project Session stopped" : "The browser recipient disconnected",
    };
  if (pending._tag === "WidgetCapture")
    return {
      ok: false,
      kind: "infrastructure",
      message: stopped ? "The Project Session stopped" : "The capture recipient disconnected",
    };
  if (pending._tag === "ProjectControl")
    return {
      ok: false,
      error: stopped
        ? "The Project Session stopped."
        : "The Project Session request was cancelled.",
    };
  return stopped
    ? { ok: false, error: "Cake Chat stopped." }
    : { ok: false, name: pending.name, error: "The Cake Chat request was cancelled." };
};

/** The coordinator's single transient correlation and settlement owner.
 * Unlocked transitions are composed only inside runTransition by its caller. */
export const makeRendererPendingRequests = Effect.fn(
  "RendererRequestCoordinator.makePendingRequests",
)(function* (clientEvents: ClientEvents["Service"]) {
  const pending = new Map<string, PendingRequest>();
  const cakeChatRequests = yield* SubscriptionRef.make<
    ReadonlyArray<CakeChatControlRequest & { readonly connectionId: number }>
  >([]);
  const transitionLock = yield* Semaphore.make(1);
  const runTransition = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    transitionLock.withPermits(1)(Effect.uninterruptible(effect));

  const removePendingUnlocked = Effect.fn("RendererRequestCoordinator.removePendingUnlocked")(
    function* (requestId: string) {
      const request = pending.get(requestId);
      if (!request) return undefined;
      pending.delete(requestId);
      if (request._tag === "Ui")
        clientEvents.sendTo(request.connectionId, {
          type: "ui-request-settled",
          uiRequestId: requestId,
          sessionId: request.sessionId,
        });
      if (request._tag === "CakeChatControl")
        yield* SubscriptionRef.update(cakeChatRequests, (requests) =>
          requests.filter((candidate) => candidate.controlRequestId !== requestId),
        );
      return request;
    },
  );

  const removePending = Effect.fn("RendererRequestCoordinator.removePending")((requestId: string) =>
    runTransition(removePendingUnlocked(requestId)),
  );

  const completeUnlocked = Effect.fn("RendererRequestCoordinator.completeUnlocked")(function* (
    requestId: string,
    value: JsonValue | undefined,
  ) {
    const request = yield* removePendingUnlocked(requestId);
    if (!request) return false;
    Deferred.doneUnsafe(request.completion, Effect.succeed(value));
    return true;
  });

  const complete = Effect.fn("RendererRequestCoordinator.complete")(
    (requestId: string, value: JsonValue | undefined) =>
      runTransition(completeUnlocked(requestId, value)),
  );

  const cancelMatchingUnlocked = Effect.fn("RendererRequestCoordinator.cancelMatchingUnlocked")(
    function* (predicate: (request: PendingRequest) => boolean, stopped: boolean) {
      const matches = [...pending].filter(([, request]) => predicate(request));
      for (const [requestId, request] of matches)
        yield* completeUnlocked(requestId, cancellationValue(request, stopped));
    },
  );

  const cancelMatching = Effect.fn("RendererRequestCoordinator.cancelMatching")(
    (predicate: (request: PendingRequest) => boolean, stopped: boolean) =>
      runTransition(cancelMatchingUnlocked(predicate, stopped)),
  );

  const awaitAbort = (signal: AbortSignal, value: JsonValue | undefined) =>
    Effect.callback<JsonValue | undefined>((resume) => {
      const onAbort = () => resume(Effect.succeed(value));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });

  const awaitPending = (
    requestId: string,
    request: PendingRequest,
    signal?: AbortSignal,
    timeout?: number,
  ) => {
    const waits: Array<Effect.Effect<JsonValue | undefined>> = [Deferred.await(request.completion)];
    if (signal)
      waits.push(
        awaitAbort(
          signal,
          request._tag === "ProjectControl"
            ? { ok: false, error: "The request was cancelled." }
            : cancellationValue(request, false),
        ),
      );
    if (timeout) waits.push(Effect.sleep(`${timeout} millis`).pipe(Effect.as(undefined)));
    return Effect.raceAll(waits).pipe(
      Effect.ensuring(removePending(requestId).pipe(Effect.asVoid)),
    );
  };

  const validateResponse = (
    operation: string,
    requestId: string,
    expectedTag: PendingRequest["_tag"],
    connectionId: number,
    sessionId?: string,
  ) => {
    const request = pending.get(requestId);
    if (!request) return undefined;
    if (request._tag !== expectedTag)
      throw coordinatorError(operation, "The response does not match the pending request type");
    if (request.connectionId !== connectionId)
      throw coordinatorError(operation, "The response came from the wrong renderer connection");
    if (sessionId !== undefined && request.sessionId !== sessionId)
      throw coordinatorError(operation, "The response targets the wrong Cake Session");
    return request;
  };

  const registerCakeChatControl = Effect.fn("RendererRequestCoordinator.registerCakeChatControl")(
    function* (
      controlRequestId: string,
      entry: Extract<PendingRequest, { _tag: "CakeChatControl" }>,
    ) {
      pending.set(controlRequestId, entry);
      yield* SubscriptionRef.update(cakeChatRequests, (requests) => [
        ...requests,
        {
          _tag: "ControlRequested" as const,
          sessionId: entry.sessionId,
          controlRequestId,
          invocation: entry.invocation,
          connectionId: entry.connectionId,
        },
      ]);
    },
  );
  return {
    add: (requestId: string, entry: PendingRequest) => {
      pending.set(requestId, entry);
    },
    discard: (requestId: string) => {
      pending.delete(requestId);
    },
    get: (requestId: string) => pending.get(requestId),
    runTransition,
    removePending,
    complete,
    completeUnlocked,
    cancelMatching,
    cancelMatchingUnlocked,
    awaitPending,
    validateResponse,
    registerCakeChatControl,
    pendingUserInputs: Effect.fn("RendererRequestCoordinator.pendingUserInputs")(() =>
      Effect.sync(() =>
        [...pending.values()].flatMap((entry) =>
          entry._tag === "Interview"
            ? [{ sessionId: entry.sessionId, reason: entry.record.request.title }]
            : entry._tag === "Ui" && entry.targetKind !== "CakeChatSession"
              ? [{ sessionId: entry.sessionId, reason: entry.title }]
              : [],
        ),
      ),
    ),

    cakeChatControlSnapshots: (connectionId?: number) =>
      SubscriptionRef.changes(cakeChatRequests).pipe(
        Stream.map((requests) =>
          requests.flatMap((request) =>
            connectionId === undefined || request.connectionId === connectionId
              ? [
                  {
                    _tag: request._tag,
                    sessionId: request.sessionId,
                    controlRequestId: request.controlRequestId,
                    invocation: request.invocation,
                  },
                ]
              : [],
          ),
        ),
      ),
  };
});
