import { Clock, Context, Deferred, Effect, Layer, Schema, type Stream } from "effect";
import { browserRequestTimeoutMs } from "../../contracts/browser/browser-deadlines";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import type { AgentActionNotice } from "../../contracts/application/agent-action-notice";
import {
  WindowControlResponse,
  type WindowControlRequest,
} from "../../contracts/application/window-control";
import type { CakeChatControlRequest } from "../../contracts/cake-chats/cake-chat-data";
import type { ProjectSessionControlInvocation } from "../../contracts/project-sessions/project-session-data";
import {
  validateInterviewResponse,
  type InterviewRecord,
  type InterviewResponse,
} from "../../contracts/interviews/interview";
import {
  cakeRpcPayloadSchemas,
  type CakeEvent,
} from "../../contracts/application/cake-rpc-contract";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { ClientConnections } from "../clients/ClientConnections";
import { ClientEvents } from "../clients/ClientEvents";
import { RenderedWidgetCaptureError } from "../../contracts/widgets/rendered-widget-capture-errors";
import { type RenderedWidgetCaptureResult } from "../widgets/RenderedWidgetCapture";
import type { CompiledInlineWidget } from "../../contracts/widgets/inline-widget-contract";
import type { WorkflowProposal } from "../../contracts/workflows/workflow-data";
import { coordinatorError, RendererRequestCoordinatorError } from "./RendererRequestError";
import {
  makeRendererPendingRequests,
  type PendingRequest,
  type SessionTarget,
} from "./RendererPendingRequests";

interface RendererUiRequest {
  readonly kind:
    | "confirm"
    | "text"
    | "secret"
    | "select"
    | "manual_code"
    | "editor"
    | "workflow-choice";
  readonly workflow?: WorkflowProposal;
  readonly title: string;
  readonly message: string;
  readonly placeholder?: string;
  readonly initialValue?: string;
  readonly multiline?: boolean;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
}

type UiResponse = (typeof cakeRpcPayloadSchemas)["respond-ui"]["Type"];

export interface RendererRequestCoordinatorService {
  /** Current presentation binding only; never creates or acquires a session. */
  readonly connectionForSession: (sessionId: string) => Effect.Effect<number | undefined>;
  readonly requestWindowControl: (
    connectionId: number,
    invocation: WindowControlRequest["invocation"],
    source?: WindowControlRequest["source"],
  ) => Effect.Effect<WindowControlResponse, RendererRequestCoordinatorError>;
  readonly respondWindowControl: (
    connectionId: number,
    controlRequestId: string,
    result: WindowControlResponse,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly requestWindowStateFlush: (
    connectionId: number,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly respondWindowStateFlush: (
    connectionId: number,
    requestId: string,
    error?: string,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  /** Best-effort presentation only; never creates a pending request or controls admission. */
  readonly presentAgentAction: (notice: AgentActionNotice) => Effect.Effect<void>;
  /** Live user-response waits only, without reading Pi or creating requests. */
  readonly pendingUserInputs: () => Effect.Effect<
    ReadonlyArray<{
      readonly sessionId: string;
      readonly reason: string;
    }>
  >;
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
  readonly requestUiForTarget: (
    target: SessionTarget,
    request: RendererUiRequest,
  ) => Effect.Effect<string | undefined, RendererRequestCoordinatorError>;
  readonly requestUiForConnection: (
    connectionId: number,
    requestScopeId: string,
    request: RendererUiRequest,
  ) => Effect.Effect<string | undefined, RendererRequestCoordinatorError>;
  readonly requestInterview: (
    sessionId: string,
    record: InterviewRecord,
    signal: AbortSignal,
  ) => Effect.Effect<JsonValue | undefined, RendererRequestCoordinatorError>;
  readonly requestProjectControl: (
    sessionId: string,
    invocation: ProjectSessionControlInvocation,
    signal: AbortSignal,
    origin?: "project-session" | "discussion-session",
  ) => Effect.Effect<JsonValue, RendererRequestCoordinatorError>;
  readonly requestCakeChatControl: (
    sessionId: string,
    invocation: { readonly name: string; readonly arguments: JsonValue },
    signal: AbortSignal,
  ) => Effect.Effect<JsonValue, RendererRequestCoordinatorError>;
  readonly requireDesktopRecipient: (
    sessionId: string,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly setPreviewBridge: (bridge: {
    acquire(
      connectionId: number,
      sessionId: string,
      port: number,
    ): Effect.Effect<{ port: number; endpoint: string; secret: string }, { message: string }>;
    releaseSession(sessionId: string): Effect.Effect<void>;
    releaseConnection(connectionId: number): Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly acquirePreview: (
    connectionId: number,
    sessionId: string,
    port: number,
  ) => Effect.Effect<
    { port: number; endpoint: string; secret: string },
    RendererRequestCoordinatorError
  >;
  readonly requireDesktopConnection: (
    sessionId: string,
    connectionId: number,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly requestBrowserNative: (
    sessionId: string,
    request: Omit<
      Extract<CakeEvent, { readonly type: "browser-native-requested" }>,
      "type" | "requestId" | "sessionId"
    >,
    signal: AbortSignal,
  ) => Effect.Effect<JsonValue, RendererRequestCoordinatorError>;
  readonly hasPendingBrowserScreenshot: (
    requestId: string,
    sessionId: string,
  ) => Effect.Effect<boolean>;
  readonly respondBrowserNative: (
    connectionId: number,
    sessionId: string,
    requestId: string,
    result: (typeof cakeRpcPayloadSchemas)["respond-browser-native"]["Type"]["result"],
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly requestWidgetCapture: (
    sessionId: string,
    widget: CompiledInlineWidget,
    signal: AbortSignal,
    pluginState?: JsonValue,
  ) => Effect.Effect<RenderedWidgetCaptureResult, RenderedWidgetCaptureError>;
  readonly hasPendingWidgetCapture: (
    requestId: string,
    sessionId: string,
  ) => Effect.Effect<boolean>;
  readonly respondWidgetCapture: (
    connectionId: number,
    sessionId: string,
    requestId: string,
    result:
      | {
          readonly ok: true;
          readonly pngBase64: string;
          readonly diagnostics: ReadonlyArray<string>;
        }
      | {
          readonly ok: false;
          readonly kind: RenderedWidgetCaptureError["kind"];
          readonly message: string;
        },
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly cakeChatControlSnapshots: (
    connectionId?: number,
  ) => Stream.Stream<ReadonlyArray<CakeChatControlRequest>>;
  readonly respondUi: (
    connectionId: number,
    sessionId: string,
    response: UiResponse,
  ) => Effect.Effect<void, RendererRequestCoordinatorError>;
  readonly respondInterview: (
    connectionId: number,
    sessionId: string,
    response: InterviewResponse,
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

/** Process-scoped correlation and targeting for renderer-bound reverse requests. */
export const RendererRequestCoordinatorLive: Layer.Layer<
  RendererRequestCoordinator,
  never,
  ClientEvents | ClientConnections
> = Layer.effect(
  RendererRequestCoordinator,
  Effect.gen(function* () {
    const clientEvents = yield* ClientEvents;
    const connections = yield* ClientConnections;
    let previewBridge:
      | Parameters<RendererRequestCoordinatorService["setPreviewBridge"]>[0]
      | undefined;
    const bindings = new Map<string, number>();
    const projectWorkingDirectories = new Map<string, string>();
    const requests = yield* makeRendererPendingRequests(clientEvents);
    const {
      runTransition,
      removePending,
      complete,
      completeUnlocked,
      cancelMatching,
      cancelMatchingUnlocked,
      awaitPending,
      validateResponse,
    } = requests;

    const requireBinding = (target: SessionTarget, desktopOnly = false) => {
      const connectionId = bindings.get(targetKey(target));
      if (connectionId === undefined)
        throw coordinatorError(
          "request",
          desktopOnly
            ? `No eligible desktop controls ${target._tag} ${target.sessionId}`
            : `No renderer is associated with ${target._tag} ${target.sessionId}`,
        );
      if (desktopOnly && connections.kind(connectionId) === "browser")
        throw coordinatorError(
          "request",
          "This operation requires a desktop renderer; it is unavailable in basic browser chat.",
        );
      return connectionId;
    };

    const publishProjectEvent = (connectionId: number, event: CakeEvent) =>
      Effect.try({
        try: () => {
          if (!clientEvents.sendTo(connectionId, event))
            throw new Error("Renderer connection has no active event subscription");
        },
        catch: (cause) =>
          coordinatorError(
            "publishProjectEvent",
            cause instanceof Error ? cause.message : String(cause),
          ),
      });

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
        runTransition(
          Effect.sync(() => {
            const current = bindings.get(targetKey(target));
            // Passive browser opens cannot steal a connected controller, whether desktop
            // or browser. A browser takes control after that recipient disconnects.
            // Pending requests retain the recipient captured at dispatch, even after a rebind.
            if (
              connections.kind(connectionId) === "browser" &&
              current !== undefined &&
              current !== connectionId
            ) {
              const ownerKind = connections.kind(current);
              if (
                ownerKind === "desktop" ||
                (target._tag === "ProjectSession" && ownerKind === "browser")
              )
                return;
            }
            bindings.set(targetKey(target), connectionId);
          }),
        ),
    );

    const requireDesktopRecipient = Effect.fn("RendererRequestCoordinator.requireDesktopRecipient")(
      (sessionId: string) =>
        Effect.try({
          try: () => {
            requireBinding({ _tag: "ProjectSession", sessionId }, true);
          },
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("requireDesktopRecipient", String(cause)),
        }),
    );

    const acquirePreview = Effect.fn("RendererRequestCoordinator.acquirePreview")(function* (
      connectionId: number,
      sessionId: string,
      port: number,
    ) {
      yield* requireDesktopConnection(sessionId, connectionId);
      if (!previewBridge)
        return yield* coordinatorError("acquirePreview", "Preview forwarding is unavailable");
      return yield* previewBridge
        .acquire(connectionId, sessionId, port)
        .pipe(Effect.mapError((error) => coordinatorError("acquirePreview", error.message)));
    });

    const requireDesktopConnection = Effect.fn(
      "RendererRequestCoordinator.requireDesktopConnection",
    )((sessionId: string, connectionId: number) =>
      Effect.try({
        try: () => {
          if (
            requireBinding(
              {
                _tag: isCakeChatSessionId(sessionId) ? "CakeChatSession" : "ProjectSession",
                sessionId,
              },
              true,
            ) !== connectionId
          )
            throw coordinatorError(
              "requireDesktopConnection",
              "Desktop renderer does not own this Project Session",
            );
        },
        catch: (cause) =>
          cause instanceof RendererRequestCoordinatorError
            ? cause
            : coordinatorError("requireDesktopConnection", String(cause)),
      }),
    );

    const requestBrowserNative = Effect.fn("RendererRequestCoordinator.requestBrowserNative")(
      function* (sessionId, request, signal) {
        if (signal.aborted)
          return yield* coordinatorError("requestBrowserNative", "Browser request cancelled");
        const connectionId = yield* Effect.try({
          try: () =>
            requireBinding(
              {
                _tag: isCakeChatSessionId(sessionId) ? "CakeChatSession" : "ProjectSession",
                sessionId,
              },
              true,
            ),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("requestBrowserNative", String(cause)),
        });
        const requestId = crypto.randomUUID();
        const completion = yield* Deferred.make<JsonValue | undefined>();
        const entry: PendingRequest = {
          _tag: "BrowserNative",
          method: request.method,
          sessionId,
          connectionId,
          completion,
        };
        requests.add(requestId, entry);
        yield* publishProjectEvent(connectionId, {
          type: "browser-native-requested",
          requestId,
          sessionId,
          ...request,
        }).pipe(Effect.tapError(() => Effect.sync(() => requests.discard(requestId))));
        const started = yield* Clock.currentTimeMillis;
        const timeoutMs = browserRequestTimeoutMs(request);
        const value = yield* awaitPending(requestId, entry, signal, timeoutMs);
        if (signal.aborted)
          return yield* coordinatorError("requestBrowserNative", "Browser request cancelled");
        if (value === undefined)
          return yield* coordinatorError(
            "requestBrowserNative",
            `Desktop browser ${request.method ?? request.operation} timed out after ${(yield* Clock.currentTimeMillis) - started}ms (deadline ${timeoutMs}ms); outcome unknown, do not automatically retry`,
          );
        return value;
      },
    );

    const respondBrowserNative = Effect.fn("RendererRequestCoordinator.respondBrowserNative")(
      (connectionId, sessionId, requestId, result) =>
        runTransition(
          Effect.gen(function* () {
            const request = validateResponse(
              "respondBrowserNative",
              requestId,
              "BrowserNative",
              connectionId,
              sessionId,
            );
            if (!request)
              return yield* coordinatorError(
                "respondBrowserNative",
                "Browser request is no longer pending",
              );
            yield* completeUnlocked(requestId, result);
          }),
        ),
    );

    const requestWidgetCapture = Effect.fn("RendererRequestCoordinator.requestWidgetCapture")(
      function* (
        sessionId: string,
        widget: CompiledInlineWidget,
        signal: AbortSignal,
        pluginState?: JsonValue,
      ) {
        const fail = (message: string) =>
          new RenderedWidgetCaptureError({ kind: "infrastructure", message });
        if (signal.aborted)
          return yield* new RenderedWidgetCaptureError({
            kind: "cancelled",
            message: "Widget review was cancelled",
          });
        const connectionId = yield* Effect.try({
          try: () => requireBinding({ _tag: "ProjectSession", sessionId }, true),
          catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause)),
        });
        const requestId = crypto.randomUUID();
        const completion = yield* Deferred.make<JsonValue | undefined>();
        const entry: PendingRequest = {
          _tag: "WidgetCapture",
          sessionId,
          connectionId,
          completion,
        };
        requests.add(requestId, entry);
        yield* publishProjectEvent(connectionId, {
          type: "widget-capture-requested",
          requestId,
          sessionId,
          widget,
          pluginState,
        }).pipe(
          Effect.tapError(() => Effect.sync(() => requests.discard(requestId))),
          Effect.mapError((cause) => fail(cause.message)),
        );
        const value = yield* awaitPending(requestId, entry, signal, 25_000);
        if (signal.aborted)
          return yield* new RenderedWidgetCaptureError({
            kind: "cancelled",
            message: "Widget review was cancelled",
          });
        if (value === undefined) return yield* fail("Desktop widget capture timed out");
        const decoded = yield* Schema.decodeUnknownEffect(
          cakeRpcPayloadSchemas["respond-widget-capture"],
        )({ requestId, sessionId, result: value }).pipe(
          Effect.mapError(() => fail("Invalid desktop capture response")),
        );
        if (!decoded.result.ok) {
          return yield* new RenderedWidgetCaptureError({
            kind: decoded.result.kind,
            message: decoded.result.message,
          });
        }
        return { pngBase64: decoded.result.pngBase64, diagnostics: decoded.result.diagnostics };
      },
    );

    const respondWidgetCapture = Effect.fn("RendererRequestCoordinator.respondWidgetCapture")(
      (
        connectionId: number,
        sessionId: string,
        requestId: string,
        result:
          | {
              readonly ok: true;
              readonly pngBase64: string;
              readonly diagnostics: ReadonlyArray<string>;
            }
          | {
              readonly ok: false;
              readonly kind: RenderedWidgetCaptureError["kind"];
              readonly message: string;
            },
      ) =>
        runTransition(
          Effect.gen(function* () {
            const request = validateResponse(
              "respondWidgetCapture",
              requestId,
              "WidgetCapture",
              connectionId,
              sessionId,
            );
            if (!request) return;
            yield* completeUnlocked(
              requestId,
              result.ok
                ? { ok: true, pngBase64: result.pngBase64, diagnostics: [...result.diagnostics] }
                : { ok: false, kind: result.kind, message: result.message },
            );
          }),
        ),
    );

    const requestUiForConnection = Effect.fn("RendererRequestCoordinator.requestUiForConnection")(
      function* (
        connectionId: number,
        requestScopeId: string,
        request: RendererUiRequest,
        targetKind?: SessionTarget["_tag"],
      ) {
        if (request.signal?.aborted) return undefined;
        const operationId = crypto.randomUUID();
        const uiRequestId = crypto.randomUUID();
        const completion = yield* Deferred.make<JsonValue | undefined>();
        const entry: PendingRequest = {
          _tag: "Ui",
          targetKind,
          workflowChoice: request.kind === "workflow-choice",
          title: request.title,
          signal: request.signal,
          sessionId: requestScopeId,
          connectionId,
          operationId,
          completion,
        };
        requests.add(uiRequestId, entry);
        let event: Extract<CakeEvent, { type: "ui-request" }> = {
          type: "ui-request",
          requestId: operationId,
          uiRequestId,
          sessionId: requestScopeId,
          kind: request.kind,
          title: request.title,
          message: request.message,
          placeholder: request.placeholder,
          initialValue: request.initialValue,
          multiline: request.multiline,
          options: request.options,
        };
        if (request.workflow !== undefined) event = { ...event, workflow: request.workflow };
        yield* publishProjectEvent(connectionId, event).pipe(
          Effect.tapError(() => Effect.sync(() => requests.discard(uiRequestId))),
        );
        const result = yield* awaitPending(uiRequestId, entry, request.signal, request.timeout);
        return yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String))(result).pipe(
          Effect.mapError((cause) => coordinatorError("requestUiForConnection", String(cause))),
        );
      },
    );

    const requestUiForTarget = Effect.fn("RendererRequestCoordinator.requestUiForTarget")(
      function* (target: SessionTarget, request: RendererUiRequest) {
        const connectionId = yield* Effect.try({
          try: () => requireBinding(target),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("requestUi", String(cause)),
        });
        return yield* requestUiForConnection(connectionId, target.sessionId, request, target._tag);
      },
    );
    const requestUi = Effect.fn("RendererRequestCoordinator.requestUi")(
      (sessionId: string, request: RendererUiRequest) =>
        requestUiForTarget({ _tag: "ProjectSession", sessionId }, request),
    );

    const requestInterview = Effect.fn("RendererRequestCoordinator.requestInterview")(function* (
      sessionId: string,
      record: InterviewRecord,
      signal: AbortSignal,
    ) {
      if (signal.aborted) return undefined;
      if (record.sessionId !== sessionId)
        return yield* coordinatorError("requestInterview", "Interview session does not match");
      const connectionId = yield* Effect.try({
        try: () => requireBinding({ _tag: "ProjectSession", sessionId }),
        catch: (cause) =>
          cause instanceof RendererRequestCoordinatorError
            ? cause
            : coordinatorError("requestInterview", String(cause)),
      });
      const operationId = crypto.randomUUID();
      const interviewRequestId = crypto.randomUUID();
      const completion = yield* Deferred.make<JsonValue | undefined>();
      const entry: PendingRequest = {
        _tag: "Interview",
        record,
        sessionId,
        connectionId,
        operationId,
        completion,
      };
      requests.add(interviewRequestId, entry);
      yield* publishProjectEvent(connectionId, {
        type: "interview-requested",
        requestId: operationId,
        interviewRequestId,
        record,
      }).pipe(Effect.tapError(() => Effect.sync(() => requests.discard(interviewRequestId))));
      return yield* awaitPending(interviewRequestId, entry, signal);
    });

    const requestWindowControl = Effect.fn("RendererRequestCoordinator.requestWindowControl")(
      function* (
        connectionId: number,
        invocation: WindowControlRequest["invocation"],
        source?: WindowControlRequest["source"],
      ) {
        if (connections.kind(connectionId) !== "desktop")
          return yield* coordinatorError(
            "requestWindowControl",
            "This operation requires a connected desktop renderer.",
          );
        const controlRequestId = crypto.randomUUID();
        const completion = yield* Deferred.make<JsonValue | undefined>();
        const entry: PendingRequest = { _tag: "WindowControl", connectionId, completion };
        requests.add(controlRequestId, entry);
        yield* publishProjectEvent(connectionId, {
          type: "window-control-requested",
          controlRequestId,
          invocation,
          ...(source === undefined ? null : { source }),
        }).pipe(Effect.tapError(() => Effect.sync(() => requests.discard(controlRequestId))));
        return yield* Schema.decodeUnknownEffect(WindowControlResponse)(
          yield* awaitPending(controlRequestId, entry),
        ).pipe(Effect.mapError((cause) => coordinatorError("requestWindowControl", cause.message)));
      },
    );

    const respondWindowControl = Effect.fn("RendererRequestCoordinator.respondWindowControl")(
      function* (connectionId: number, controlRequestId: string, result: WindowControlResponse) {
        const request = yield* Effect.try({
          try: () =>
            validateResponse(
              "respondWindowControl",
              controlRequestId,
              "WindowControl",
              connectionId,
            ),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("respondWindowControl", String(cause)),
        });
        if (request) yield* complete(controlRequestId, result);
      },
    );

    const requestProjectControl = Effect.fn("RendererRequestCoordinator.requestProjectControl")(
      function* (
        sessionId: string,
        invocation: ProjectSessionControlInvocation,
        signal: AbortSignal,
        origin: "project-session" | "discussion-session" = "project-session",
      ) {
        if (signal.aborted) return { ok: false, error: "The request was cancelled." };
        const connectionId = yield* Effect.try({
          try: () => requireBinding({ _tag: "ProjectSession", sessionId }, true),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("requestProjectControl", String(cause)),
        });
        const controlRequestId = crypto.randomUUID();
        const completion = yield* Deferred.make<JsonValue | undefined>();
        const entry: PendingRequest = {
          _tag: "ProjectControl",
          origin,
          sessionId,
          connectionId,
          completion,
        };
        requests.add(controlRequestId, entry);
        const event: CakeEvent & { readonly type: "project-session-control-requested" } = {
          type: "project-session-control-requested",
          sessionId,
          controlRequestId,
          invocation,
        };
        yield* publishProjectEvent(connectionId, event).pipe(
          Effect.tapError(() => Effect.sync(() => requests.discard(controlRequestId))),
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
          try: () => requireBinding({ _tag: "CakeChatSession", sessionId }, true),
          catch: (cause) =>
            cause instanceof RendererRequestCoordinatorError
              ? cause
              : coordinatorError("requestCakeChatControl", String(cause)),
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const controlRequestId = crypto.randomUUID();
            const completion = yield* Deferred.make<JsonValue | undefined>();
            const entry: PendingRequest = {
              _tag: "CakeChatControl",
              sessionId,
              connectionId,
              name: invocation.name,
              invocation,
              completion,
            };
            const registered = yield* runTransition(
              Effect.gen(function* () {
                if (
                  bindings.get(targetKey({ _tag: "CakeChatSession", sessionId })) !== connectionId
                )
                  return false;
                yield* requests.registerCakeChatControl(controlRequestId, entry);
                return true;
              }),
            );
            if (!registered)
              return {
                ok: false,
                name: invocation.name,
                error: "Cake Chat stopped.",
              };
            return (
              (yield* restore(awaitPending(controlRequestId, entry, signal))) ?? {
                ok: false,
                name: invocation.name,
                error: "The Cake Chat request was cancelled.",
              }
            );
          }),
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
      if (
        request?._tag === "Ui" &&
        request.workflowChoice &&
        !response.cancelled &&
        response.value !== "workflow" &&
        response.value !== "normal"
      )
        return yield* coordinatorError("respondUi", "Invalid workflow execution choice");
      if (request)
        yield* complete(
          response.uiRequestId,
          response.cancelled || (request._tag === "Ui" && request.signal?.aborted)
            ? undefined
            : response.value,
        );
    });

    const respondInterview = Effect.fn("RendererRequestCoordinator.respondInterview")(function* (
      connectionId: number,
      sessionId: string,
      response: InterviewResponse,
    ) {
      const request = yield* Effect.try({
        try: () =>
          validateResponse(
            "respondInterview",
            response.interviewRequestId,
            "Interview",
            connectionId,
            sessionId,
          ),
        catch: (cause) =>
          cause instanceof RendererRequestCoordinatorError
            ? cause
            : coordinatorError("respondInterview", String(cause)),
      });
      if (request?._tag !== "Interview")
        return yield* coordinatorError(
          "respondInterview",
          "This interview is no longer waiting for a response",
        );
      if (request.operationId !== response.requestId)
        return yield* coordinatorError(
          "respondInterview",
          "The response correlation ID does not match",
        );
      const value = response.cancelled
        ? undefined
        : yield* Effect.try({
            try: () =>
              validateInterviewResponse(request.record.request.responseSchema, response.value),
            catch: (cause) =>
              coordinatorError(
                "respondInterview",
                cause instanceof Error ? cause.message : String(cause),
              ),
          });
      yield* complete(response.interviewRequestId, value);
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
        if (request) yield* complete(controlRequestId, result);
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
        yield* complete(controlRequestId, result);
      },
    );

    const releaseSession = Effect.fn("RendererRequestCoordinator.releaseSession")(
      (target: SessionTarget) =>
        runTransition(
          Effect.gen(function* () {
            bindings.delete(targetKey(target));
            if (target._tag === "ProjectSession") {
              projectWorkingDirectories.delete(target.sessionId);
              if (previewBridge) yield* previewBridge.releaseSession(target.sessionId);
            }
            yield* cancelMatchingUnlocked(
              (request) =>
                request.sessionId === target.sessionId &&
                // A sidecar can resolve its parent. Its own signal/connection,
                // not the parent's runtime release, owns that tool response.
                !(request._tag === "ProjectControl" && request.origin === "discussion-session") &&
                ((target._tag === "ProjectSession" && request._tag !== "CakeChatControl") ||
                  (target._tag === "CakeChatSession" &&
                    (request._tag === "CakeChatControl" ||
                      (request._tag === "Ui" && request.targetKind === "CakeChatSession")))),
              true,
            );
          }),
        ),
    );

    const releaseWorkingDirectory = Effect.fn("RendererRequestCoordinator.releaseWorkingDirectory")(
      function* (workingDirectory: string) {
        const sessionIds = new Set(
          [...projectWorkingDirectories].flatMap(([sessionId, directory]) =>
            directory === workingDirectory ? [sessionId] : [],
          ),
        );
        for (const sessionId of sessionIds) {
          bindings.delete(targetKey({ _tag: "ProjectSession", sessionId }));
          projectWorkingDirectories.delete(sessionId);
        }
        if (previewBridge)
          for (const sessionId of sessionIds) yield* previewBridge.releaseSession(sessionId);
        yield* cancelMatching(
          (request) =>
            request._tag !== "CakeChatControl" &&
            !(request._tag === "ProjectControl" && request.origin === "discussion-session") &&
            request.sessionId !== undefined &&
            sessionIds.has(request.sessionId),
          true,
        );
      },
    );

    const releaseConnection = Effect.fn("RendererRequestCoordinator.releaseConnection")(
      (connectionId: number) =>
        runTransition(
          Effect.gen(function* () {
            for (const [key, boundConnectionId] of bindings)
              if (boundConnectionId === connectionId) bindings.delete(key);
            if (previewBridge) yield* previewBridge.releaseConnection(connectionId);
            yield* cancelMatchingUnlocked(
              (request) => request.connectionId === connectionId,
              false,
            );
          }),
        ),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* cancelMatching(() => true, true);
        bindings.clear();
        projectWorkingDirectories.clear();
      }),
    );

    return RendererRequestCoordinator.of({
      connectionForSession: Effect.fn("RendererRequestCoordinator.connectionForSession")(
        (sessionId) =>
          Effect.sync(() =>
            bindings.get(
              targetKey({
                _tag: isCakeChatSessionId(sessionId) ? "CakeChatSession" : "ProjectSession",
                sessionId,
              }),
            ),
          ),
      ),
      requestWindowStateFlush: Effect.fn("RendererRequestCoordinator.requestWindowStateFlush")(
        function* (connectionId) {
          const requestId = crypto.randomUUID();
          const completion = yield* Deferred.make<JsonValue | undefined>();
          const entry: PendingRequest = {
            _tag: "WindowStateFlush",
            sessionId: "",
            connectionId,
            completion,
          };
          const result = yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* runTransition(Effect.sync(() => requests.add(requestId, entry)));
              return yield* restore(
                publishProjectEvent(connectionId, {
                  type: "window-state-flush-requested",
                  requestId,
                }).pipe(Effect.andThen(awaitPending(requestId, entry, undefined, 5_000))),
              ).pipe(Effect.ensuring(removePending(requestId)));
            }),
          );
          if (result !== null)
            return yield* coordinatorError(
              "requestWindowStateFlush",
              Schema.is(Schema.String)(result)
                ? result
                : "The window did not finish saving its settings",
            );
        },
      ),
      respondWindowStateFlush: Effect.fn("RendererRequestCoordinator.respondWindowStateFlush")(
        function* (connectionId, requestId, error) {
          const request = yield* Effect.try({
            try: () =>
              validateResponse(
                "respondWindowStateFlush",
                requestId,
                "WindowStateFlush",
                connectionId,
              ),
            catch: (cause) =>
              cause instanceof RendererRequestCoordinatorError
                ? cause
                : coordinatorError("respondWindowStateFlush", String(cause)),
          });
          if (request) yield* complete(requestId, error ?? null);
        },
      ),
      pendingUserInputs: requests.pendingUserInputs,
      registerProjectSession,
      bind,
      requestUi,
      requestUiForTarget,
      requestUiForConnection,
      requestInterview,
      presentAgentAction: Effect.fn("RendererRequestCoordinator.presentAgentAction")((notice) =>
        Effect.try({
          try: () =>
            requireBinding(
              {
                _tag: notice.source.kind === "cake-chat" ? "CakeChatSession" : "ProjectSession",
                sessionId: notice.source.sessionId,
              },
              true,
            ),
          catch: () => undefined,
        }).pipe(
          Effect.match({
            onFailure: () => undefined,
            onSuccess: (connectionId) => {
              clientEvents.sendTo(connectionId, { type: "agent-action-notice", ...notice });
            },
          }),
        ),
      ),
      requestWindowControl,
      respondWindowControl,
      requestProjectControl,
      requestCakeChatControl,
      requestWidgetCapture,
      requestBrowserNative,
      respondBrowserNative,
      hasPendingBrowserScreenshot: (requestId, sessionId) =>
        Effect.sync(() => {
          const request = requests.get(requestId);
          return (
            request?._tag === "BrowserNative" &&
            request.sessionId === sessionId &&
            request.method === "Page.captureScreenshot"
          );
        }),
      requireDesktopRecipient,
      requireDesktopConnection,
      setPreviewBridge: (bridge) =>
        Effect.sync(() => {
          previewBridge = bridge;
        }),
      acquirePreview,
      respondWidgetCapture,
      hasPendingWidgetCapture: (requestId, sessionId) =>
        Effect.sync(() => {
          const request = requests.get(requestId);
          return request?._tag === "WidgetCapture" && request.sessionId === sessionId;
        }),
      cakeChatControlSnapshots: requests.cakeChatControlSnapshots,
      respondUi,
      respondInterview,
      respondProjectControl,
      respondCakeChatControl,
      releaseSession,
      releaseWorkingDirectory,
      releaseConnection,
    });
  }),
);
