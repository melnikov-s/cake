import { Context, Deferred, Effect, Layer, PubSub, Schema, Stream } from "effect";
import type { CakeChatControlRequest } from "../../domain/cake-chat-data";
import type { ProjectSessionControlInvocation } from "../../domain/project-session-data";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { CakeEvent, cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import type { JsonValue } from "../../ipc/json-contract";
import { Electron } from "../electron/Electron";

interface RendererUiRequest {
  readonly kind: "confirm" | "text" | "secret" | "select" | "manual_code" | "editor";
  readonly title: string;
  readonly message: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly multiline?: boolean;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

type ArtifactResponse = (typeof cakeRpcPayloadSchemas)["respond-artifact"]["Type"];
type UiResponse = (typeof cakeRpcPayloadSchemas)["respond-ui"]["Type"];

type SessionTarget =
  | { readonly _tag: "ProjectSession"; readonly sessionId: string }
  | { readonly _tag: "CakeChatSession"; readonly sessionId: string };

type PendingRequest =
  | {
      readonly _tag: "Ui";
      readonly sessionId: string;
      readonly connectionId: number;
      readonly operationId: string;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "Artifact";
      readonly sessionId: string;
      readonly connectionId: number;
      readonly operationId: string;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "ProjectControl";
      readonly sessionId: string;
      readonly connectionId: number;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    }
  | {
      readonly _tag: "CakeChatControl";
      readonly sessionId: string;
      readonly connectionId: number;
      readonly name: string;
      readonly completion: Deferred.Deferred<JsonValue | undefined>;
    };

export class RendererRequestCoordinatorError extends Schema.TaggedError<RendererRequestCoordinatorError>()(
  "RendererRequestCoordinatorError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface RendererRequestCoordinatorService {
  readonly registerProjectSession: (
    sessionId: string,
    workingDirectory: string,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly bind: (
    target: SessionTarget,
    connectionId: number,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly requestUi: (
    sessionId: string,
    request: RendererUiRequest,
  ) => Effect.Effect<string | undefined, RendererRequestCoordinatorError>;
  readonly requestArtifact: (
    sessionId: string,
    record: ArtifactRecord,
    signal: AbortSignal,
  ) => Effect.Effect<JsonValue | undefined, RendererRequestCoordinatorError>;
  readonly requestProjectControl: (
    sessionId: string,
    invocation: ProjectSessionControlInvocation,
    signal: AbortSignal,
  ) => Effect.Effect<JsonValue, RendererRequestCoordinatorError>;
  readonly requestCakeChatControl: (
    sessionId: string,
    invocation: { readonly name: string; readonly arguments: JsonValue },
    signal: AbortSignal,
  ) => Effect.Effect<JsonValue, RendererRequestCoordinatorError>;
  readonly cakeChatControlRequests: (
    connectionId?: number,
  ) => Stream.Stream<CakeChatControlRequest>;
  readonly respondUi: (
    connectionId: number,
    sessionId: string,
    response: UiResponse,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly respondArtifact: (
    connectionId: number,
    sessionId: string,
    response: ArtifactResponse,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly respondProjectControl: (
    connectionId: number,
    sessionId: string,
    controlRequestId: string,
    result: JsonValue,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly respondCakeChatControl: (
    connectionId: number,
    controlRequestId: string,
    result: JsonValue,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly releaseSession: (target: SessionTarget) => Effect.Effect<void>;
  readonly releaseWorkingDirectory: (workingDirectory: string) => Effect.Effect<void>;
  readonly releaseConnection: (connectionId: number) => Effect.Effect<void>;
}

export class RendererRequestCoordinator extends Context.Service<
  RendererRequestCoordinator,
  RendererRequestCoordinatorService
>()("cake/services/renderer-requests/RendererRequestCoordinator") {}

const targetKey = (target: SessionTarget) => `${target._tag}:${target.sessionId}`;

const coordinatorError = (operation: string, message: string) =>
  new RendererRequestCoordinatorError({ operation, message });

const cancellationValue = (pending: PendingRequest, stopped: boolean): JsonValue | undefined => {
  if (pending._tag === "Ui" || pending._tag === "Artifact") return undefined;
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

/** Process-scoped correlation and targeting for renderer-bound reverse requests. */
export const RendererRequestCoordinatorLive: Layer.Layer<
  RendererRequestCoordinator,
  never,
  Electron
> = Layer.effect(
  RendererRequestCoordinator,
  Effect.gen(function* () {
    const electron = yield* Electron;
    const bindings = new Map<string, number>();
    const projectWorkingDirectories = new Map<string, string>();
    const pending = new Map<string, PendingRequest>();
    const cakeChatRequests = yield* PubSub.unbounded<
      CakeChatControlRequest & { readonly connectionId: number }
    >();

    const requireBinding = (target: SessionTarget) => {
      const connectionId = bindings.get(targetKey(target));
      if (connectionId === undefined)
        throw coordinatorError(
          "request",
          `No renderer is associated with ${target._tag} ${target.sessionId}`,
        );
      return connectionId;
    };

    const complete = (requestId: string, value: JsonValue | undefined) => {
      const request = pending.get(requestId);
      if (!request) return false;
      pending.delete(requestId);
      Deferred.doneUnsafe(request.completion, Effect.succeed(value));
      return true;
    };

    const cancelMatching = (predicate: (request: PendingRequest) => boolean, stopped: boolean) => {
      for (const [requestId, request] of pending)
        if (predicate(request)) {
          complete(requestId, cancellationValue(request, stopped));
          pending.delete(requestId);
        }
    };

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
      const waits: Array<Effect.Effect<JsonValue | undefined>> = [
        Deferred.await(request.completion),
      ];
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
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(requestId);
          }),
        ),
      );
    };

    const publishProjectEvent = (connectionId: number, event: CakeEvent) =>
      Effect.try({
        try: () => electron.sendTo(electron.requireRendererConnection(connectionId), event),
        catch: (cause) =>
          coordinatorError(
            "publishProjectEvent",
            cause instanceof Error ? cause.message : String(cause),
          ),
      });

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

    const registerProjectSession = Effect.fn("RendererRequestCoordinator.registerProjectSession")(
      function* (sessionId: string, workingDirectory: string) {
        const existing = projectWorkingDirectories.get(sessionId);
        if (existing !== undefined && existing !== workingDirectory)
          return yield* coordinatorError(
            "registerProjectSession",
            `Session ID collision detected: ${sessionId}`,
          );
        projectWorkingDirectories.set(sessionId, workingDirectory);
      },
    );

    const bind = Effect.fn("RendererRequestCoordinator.bind")(
      (target: SessionTarget, connectionId: number) =>
        Effect.sync(() => bindings.set(targetKey(target), connectionId)),
    );

    const requestUi = Effect.fn("RendererRequestCoordinator.requestUi")(function* (
      sessionId: string,
      request: RendererUiRequest,
    ) {
      const connectionId = yield* Effect.try({
        try: () => requireBinding({ _tag: "ProjectSession", sessionId }),
        catch: (cause) =>
          cause instanceof RendererRequestCoordinatorError
            ? cause
            : coordinatorError("requestUi", String(cause)),
      });
      if (request.signal?.aborted) return undefined;
      const operationId = crypto.randomUUID();
      const uiRequestId = crypto.randomUUID();
      const completion = yield* Deferred.make<JsonValue | undefined>();
      const entry: PendingRequest = {
        _tag: "Ui",
        sessionId,
        connectionId,
        operationId,
        completion,
      };
      pending.set(uiRequestId, entry);
      yield* publishProjectEvent(connectionId, {
        type: "ui-request",
        requestId: operationId,
        uiRequestId,
        kind: request.kind,
        title: request.title,
        message: request.message,
        placeholder: request.placeholder,
        initialValue: request.initialValue,
        multiline: request.multiline,
        options: request.options,
      }).pipe(Effect.tapError(() => Effect.sync(() => pending.delete(uiRequestId))));
      const result = yield* awaitPending(uiRequestId, entry, request.signal, request.timeout);
      return yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String))(result).pipe(
        Effect.mapError((cause) => coordinatorError("requestUi", String(cause))),
      );
    });

    const requestArtifact = Effect.fn("RendererRequestCoordinator.requestArtifact")(function* (
      sessionId: string,
      record: ArtifactRecord,
      signal: AbortSignal,
    ) {
      if (signal.aborted) return undefined;
      const connectionId = yield* Effect.try({
        try: () => requireBinding({ _tag: "ProjectSession", sessionId }),
        catch: (cause) =>
          cause instanceof RendererRequestCoordinatorError
            ? cause
            : coordinatorError("requestArtifact", String(cause)),
      });
      const operationId = crypto.randomUUID();
      const artifactRequestId = crypto.randomUUID();
      const completion = yield* Deferred.make<JsonValue | undefined>();
      const entry: PendingRequest = {
        _tag: "Artifact",
        sessionId,
        connectionId,
        operationId,
        completion,
      };
      pending.set(artifactRequestId, entry);
      yield* publishProjectEvent(connectionId, {
        type: "artifact-requested",
        requestId: operationId,
        artifactRequestId,
        record,
      }).pipe(Effect.tapError(() => Effect.sync(() => pending.delete(artifactRequestId))));
      return yield* awaitPending(artifactRequestId, entry, signal);
    });

    const requestProjectControl = Effect.fn("RendererRequestCoordinator.requestProjectControl")(
      function* (
        sessionId: string,
        invocation: ProjectSessionControlInvocation,
        signal: AbortSignal,
      ) {
        if (signal.aborted) return { ok: false, error: "The request was cancelled." };
        const connectionId = yield* Effect.try({
          try: () => requireBinding({ _tag: "ProjectSession", sessionId }),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("requestProjectControl", String(cause)),
        });
        const controlRequestId = crypto.randomUUID();
        const completion = yield* Deferred.make<JsonValue | undefined>();
        const entry: PendingRequest = {
          _tag: "ProjectControl",
          sessionId,
          connectionId,
          completion,
        };
        pending.set(controlRequestId, entry);
        const event: CakeEvent & { readonly type: "project-session-control-requested" } = {
          type: "project-session-control-requested",
          sessionId,
          controlRequestId,
          invocation,
        };
        yield* publishProjectEvent(connectionId, event).pipe(
          Effect.tapError(() => Effect.sync(() => pending.delete(controlRequestId))),
        );
        return (
          (yield* awaitPending(controlRequestId, entry, signal)) ?? {
            ok: false,
            error: "The request was cancelled.",
          }
        );
      },
    );

    const requestCakeChatControl = Effect.fn("RendererRequestCoordinator.requestCakeChatControl")(
      function* (
        sessionId: string,
        invocation: { readonly name: string; readonly arguments: JsonValue },
        signal: AbortSignal,
      ) {
        if (signal.aborted)
          return {
            ok: false,
            name: invocation.name,
            error: "The Cake Chat request was cancelled.",
          };
        const connectionId = yield* Effect.try({
          try: () => requireBinding({ _tag: "CakeChatSession", sessionId }),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("requestCakeChatControl", String(cause)),
        });
        const controlRequestId = crypto.randomUUID();
        const completion = yield* Deferred.make<JsonValue | undefined>();
        const entry: PendingRequest = {
          _tag: "CakeChatControl",
          sessionId,
          connectionId,
          name: invocation.name,
          completion,
        };
        pending.set(controlRequestId, entry);
        yield* PubSub.publish(cakeChatRequests, {
          _tag: "ControlRequested",
          sessionId,
          controlRequestId,
          invocation,
          connectionId,
        });
        return (
          (yield* awaitPending(controlRequestId, entry, signal)) ?? {
            ok: false,
            name: invocation.name,
            error: "The Cake Chat request was cancelled.",
          }
        );
      },
    );

    const respondUi = Effect.fn("RendererRequestCoordinator.respondUi")(function* (
      connectionId: number,
      sessionId: string,
      response: UiResponse,
    ) {
      const request = yield* Effect.try({
        try: () =>
          validateResponse("respondUi", response.uiRequestId, "Ui", connectionId, sessionId),
        catch: (cause) =>
          cause instanceof RendererRequestCoordinatorError
            ? cause
            : coordinatorError("respondUi", String(cause)),
      });
      if (request?._tag === "Ui" && request.operationId !== response.requestId)
        return yield* coordinatorError("respondUi", "The response correlation ID does not match");
      if (request) complete(response.uiRequestId, response.cancelled ? undefined : response.value);
    });

    const respondArtifact = Effect.fn("RendererRequestCoordinator.respondArtifact")(function* (
      connectionId: number,
      sessionId: string,
      response: ArtifactResponse,
    ) {
      const request = yield* Effect.try({
        try: () =>
          validateResponse(
            "respondArtifact",
            response.artifactRequestId,
            "Artifact",
            connectionId,
            sessionId,
          ),
        catch: (cause) =>
          cause instanceof RendererRequestCoordinatorError
            ? cause
            : coordinatorError("respondArtifact", String(cause)),
      });
      if (request?._tag === "Artifact" && request.operationId !== response.requestId)
        return yield* coordinatorError(
          "respondArtifact",
          "The response correlation ID does not match",
        );
      if (request)
        complete(response.artifactRequestId, response.cancelled ? undefined : response.value);
    });

    const respondProjectControl = Effect.fn("RendererRequestCoordinator.respondProjectControl")(
      function* (
        connectionId: number,
        sessionId: string,
        controlRequestId: string,
        result: JsonValue,
      ) {
        const request = yield* Effect.try({
          try: () =>
            validateResponse(
              "respondProjectControl",
              controlRequestId,
              "ProjectControl",
              connectionId,
              sessionId,
            ),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("respondProjectControl", String(cause)),
        });
        // Session release may win while the renderer completes the requested mutation.
        if (request) complete(controlRequestId, result);
      },
    );

    const respondCakeChatControl = Effect.fn("RendererRequestCoordinator.respondCakeChatControl")(
      function* (connectionId: number, controlRequestId: string, result: JsonValue) {
        const request = yield* Effect.try({
          try: () =>
            validateResponse(
              "respondCakeChatControl",
              controlRequestId,
              "CakeChatControl",
              connectionId,
            ),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("respondCakeChatControl", String(cause)),
        });
        if (!request)
          return yield* coordinatorError(
            "respondCakeChatControl",
            "That Cake Chat control request is no longer pending",
          );
        complete(controlRequestId, result);
      },
    );

    const releaseSession = Effect.fn("RendererRequestCoordinator.releaseSession")(
      (target: SessionTarget) =>
        Effect.sync(() => {
          bindings.delete(targetKey(target));
          if (target._tag === "ProjectSession") projectWorkingDirectories.delete(target.sessionId);
          cancelMatching(
            (request) =>
              request.sessionId === target.sessionId &&
              ((target._tag === "ProjectSession" && request._tag !== "CakeChatControl") ||
                (target._tag === "CakeChatSession" && request._tag === "CakeChatControl")),
            true,
          );
        }),
    );

    const releaseWorkingDirectory = Effect.fn("RendererRequestCoordinator.releaseWorkingDirectory")(
      (workingDirectory: string) =>
        Effect.sync(() => {
          const sessionIds = new Set(
            [...projectWorkingDirectories].flatMap(([sessionId, directory]) =>
              directory === workingDirectory ? [sessionId] : [],
            ),
          );
          for (const sessionId of sessionIds) {
            bindings.delete(targetKey({ _tag: "ProjectSession", sessionId }));
            projectWorkingDirectories.delete(sessionId);
          }
          cancelMatching(
            (request) => request._tag !== "CakeChatControl" && sessionIds.has(request.sessionId),
            true,
          );
        }),
    );

    const releaseConnection = Effect.fn("RendererRequestCoordinator.releaseConnection")(
      (connectionId: number) =>
        Effect.sync(() => {
          for (const [key, boundConnectionId] of bindings)
            if (boundConnectionId === connectionId) bindings.delete(key);
          cancelMatching((request) => request.connectionId === connectionId, false);
        }),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        cancelMatching(() => true, true);
        bindings.clear();
        projectWorkingDirectories.clear();
        yield* PubSub.shutdown(cakeChatRequests);
      }),
    );

    return RendererRequestCoordinator.of({
      registerProjectSession,
      bind,
      requestUi,
      requestArtifact,
      requestProjectControl,
      requestCakeChatControl,
      cakeChatControlRequests: (connectionId) =>
        Stream.fromPubSub(cakeChatRequests).pipe(
          Stream.filter(
            (request) => connectionId === undefined || request.connectionId === connectionId,
          ),
          Stream.map((request) => ({
            _tag: request._tag,
            sessionId: request.sessionId,
            controlRequestId: request.controlRequestId,
            invocation: request.invocation,
          })),
        ),
      respondUi,
      respondArtifact,
      respondProjectControl,
      respondCakeChatControl,
      releaseSession,
      releaseWorkingDirectory,
      releaseConnection,
    });
  }),
);
