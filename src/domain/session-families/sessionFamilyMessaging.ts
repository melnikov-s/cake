import {
  SessionMessageDelivery,
  SessionMessageDeliveryOptions,
  sessionMessageDeliveryCheck,
  immediateDelivery,
} from "../../contracts/conversations/session-message-delivery";
import * as projectTodoUpdates from "../projects/projectTodoUpdates";
import { ResultDelivery } from "../../contracts/conversations/result-delivery";
import { messageRefsSchema } from "../../contracts/conversations/message-reference";
import { appendMessageReferences } from "../../contracts/conversations/message-reference-forwarding";
import { isReferenceNotification } from "../../contracts/conversations/reference-notification";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { prepareTaskInputs } from "../conversations/taskInputs";
import { Effect, Schema, type Scope } from "effect";
import {
  crossSessionContextSnapshot,
  encodeCrossSessionMessage,
  type CrossSessionContextSnapshot,
} from "../../contracts/conversations/cross-session-message";
import { substantiveTurnResult } from "../../contracts/pi/turn-result-data";
import { SessionTaskOutcome } from "../../contracts/project-sessions/session-reporting";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import {
  ProjectSessionError,
  type ProjectSessionLocation,
} from "../../contracts/project-sessions/project-session-data";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { SessionFamilyStorage, familyMember } from "../../services/storage/SessionFamilyStorage";
import { toJsonValue } from "../../utils/to-json-value";
import { inheritTaskInputProtection } from "../conversations/taskInputs";
import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import { acquireOptions } from "../project-sessions/projectSessionRuntime";
import * as sessionFamilies from "./sessionFamilies";

/** Receiving contract for the runtime callback adapter. */
export const FamilyMessageInput = Schema.Struct({
  messageRefs: Schema.optionalKey(messageRefsSchema),
  inputRefs: Schema.optionalKey(inputRefsSchema),
  sessionId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  delivery: Schema.optionalKey(SessionMessageDelivery),
  threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  maxMessages: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  ),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  outcome: Schema.optionalKey(SessionTaskOutcome),
  resultKind: Schema.optionalKey(Schema.Literals(["ready", "investigation"])),
}).check(sessionMessageDeliveryCheck);
export interface FamilyMessageInput extends Schema.Schema.Type<typeof FamilyMessageInput> {}

export interface FamilyMessageCaller {
  readonly sessionId: string;
  readonly location: ProjectSessionLocation;
}

const routingError = (cause: unknown) =>
  new ProjectSessionError({
    operation: "familyMessage",
    message: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * Complete family routing/correlation/delivery workflow, owned by the caller's Scope.
 * undefined retains the existing not-handled fallback. Runtime acquisition stays
 * with the Project Session composition point; Pi owns admission and its queue.
 */
export const route: (
  caller: FamilyMessageCaller,
  command: "sessions.send" | "sessions.reply",
  input: FamilyMessageInput,
  senderContext?: CrossSessionContextSnapshot,
) => Effect.Effect<
  JsonValue | undefined,
  ProjectSessionError,
  Effect.Services<ReturnType<typeof acquireOptions>> | Scope.Scope
> = Effect.fn("SessionFamilyMessaging.route")(function* (
  { sessionId, location },
  command,
  input,
  senderContext,
) {
  yield* Schema.decodeUnknownEffect(SessionMessageDeliveryOptions)(input).pipe(
    Effect.mapError(routingError),
  );
  const families = yield* SessionFamilyStorage;
  const sessions = yield* CakeSessionRuntimes;
  const configuration = yield* ProjectSessionConfiguration;
  const catalogs = yield* SessionCatalogChanges;
  const family = yield* families.familyForMember(sessionId);
  const spawnedResult = yield* sessionFamilies.routeCoordinatorMessage(
    sessionId,
    command,
    input,
    location,
    senderContext,
  );
  if (spawnedResult !== undefined) return spawnedResult;
  if (!family) return undefined;
  const executingTurnIds =
    command === "sessions.reply"
      ? yield* sessions.executingTurnIds({
          sessionId,
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
        })
      : [];
  const pending =
    command === "sessions.reply"
      ? yield* families.pendingResponseRequest(
          sessionId,
          executingTurnIds,
          input.threadId,
          input.replyToMessageId,
        )
      : undefined;
  if (command === "sessions.reply" && !pending) return undefined;
  const messageText = appendMessageReferences(input.text, input.messageRefs ?? []);
  let recordedReportTurnId: string | undefined;
  if (pending && pending.outcome === undefined && input.outcome) {
    if (!substantiveTurnResult({ stopReason: "stop", text: input.text }))
      return yield* routingError(
        "A terminal report must contain substantive findings, changes, or a blocker",
      );
    yield* families.recordReport(pending.turnId, {
      outcome: input.outcome,
      ...(input.resultKind ? { resultKind: input.resultKind } : null),
      text: messageText,
    });
    recordedReportTurnId = pending.turnId;
    yield* projectTodoUpdates.offer({
      sessionId,
      projectPath: location.projectPath,
      text: input.text,
    });
    // Explicit attachments still need authorization and destination admission below.
    if (!input.inputRefs?.length)
      return toJsonValue({
        ok: true,
        command,
        status: "report-recorded",
        expectsResponse: false,
      });
  }
  const targetSessionId = pending?.senderSessionId ?? input.sessionId;
  if (!targetSessionId) return yield* routingError("A target session is required");
  const destinationMember = familyMember(family, targetSessionId);
  if (!destinationMember) return undefined;
  const destinationLocation = (yield* projectSessionLocations.locations({
    includeInactive: true,
  })).find(
    (candidate) =>
      candidate.projectPath === family.projectPath &&
      candidate.workingDirectory === destinationMember.workingDirectory,
  );
  if (!destinationLocation)
    return yield* routingError(
      `Working Directory unavailable: ${destinationMember.workingDirectory}`,
    );
  const namespace = yield* resolutionNamespace(targetSessionId, {
    cwd: destinationMember.workingDirectory,
    activeRoot: configuration.sessionDirectory,
    resolvedRoot: configuration.resolvedSessionDirectory,
  });
  if (namespace === "resolved")
    return yield* routingError(
      `Session Family ${family.familyId} is resolved; restore it explicitly before messaging`,
    );
  if (!namespace) return yield* routingError(`Family member ${targetSessionId} could not be found`);
  const destination = yield* sessions.acquire(
    yield* acquireOptions({
      location: destinationLocation,
      sessionId: targetSessionId,
      newSession: false,
    }),
  );
  yield* inheritTaskInputProtection(sessionId, targetSessionId);
  const destinationSnapshot = yield* destination.snapshot();
  const destinationSummary = yield* sessions
    .catalogEntry(
      {
        workingDirectory: destinationLocation.workingDirectory,
        sessionDirectory: destinationLocation.sessionDirectory,
      },
      targetSessionId,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  const senderSummary = yield* sessions
    .catalogEntry(
      {
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
      },
      sessionId,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  const messageId = crypto.randomUUID();
  const threadId = pending?.threadId ?? input.threadId ?? crypto.randomUUID();
  const replyToMessageId = pending?.requestMessageId ?? input.replyToMessageId;
  const delivery = immediateDelivery(destinationSnapshot.streaming, input.delivery);
  const resultDelivery = delivery === "fyi" ? "ignore" : (input.resultDelivery ?? "notification");
  const expectsResponse = resultDelivery !== "ignore";
  const messageMetadata = {
    version: 1 as const,
    messageId,
    threadId,
    sequence: 1,
    expectsResponse,
    resultDelivery,
    ...(replyToMessageId ? { replyToMessageId } : null),
    ...(senderContext ? { context: senderContext } : null),
    sender: {
      sessionId,
      title: senderSummary?.title ?? `Project Session ${sessionId}`,
      kind: "project-session" as const,
      projectName: location.projectName,
      workingDirectory: location.workingDirectory,
    },
  };
  const encoded = encodeCrossSessionMessage(
    messageText,
    input.maxMessages === undefined
      ? messageMetadata
      : { ...messageMetadata, maxMessages: input.maxMessages },
  );
  if (
    replyToMessageId &&
    !(yield* families.prepareResponse(
      sessionId,
      targetSessionId,
      replyToMessageId,
      messageId,
      executingTurnIds,
    ))
  )
    return yield* routingError(
      `Request ${replyToMessageId} is not awaiting a response from this session`,
    );
  const preparedRequests = replyToMessageId
    ? (yield* families.state()).turns.filter((turn) => turn.replyMessageIds?.includes(messageId))
    : [];
  if (substantiveTurnResult({ stopReason: "stop", text: input.text })) {
    if (preparedRequests.length && recordedReportTurnId === undefined)
      yield* projectTodoUpdates.offer({
        sessionId,
        projectPath: location.projectPath,
        text: input.text,
      });
    for (const request of preparedRequests)
      if (request.turnId !== recordedReportTurnId)
        yield* families.recordReport(request.turnId, {
          outcome: input.outcome ?? "result",
          ...(input.resultKind ? { resultKind: input.resultKind } : null),
          text: messageText,
        });
  }
  if (delivery === "fyi") {
    yield* families.deferPassiveNotice({
      id: messageId,
      recipientSessionId: targetSessionId,
      text: messageText,
      crossSession: messageMetadata,
    });
    if (!preparedRequests.length && substantiveTurnResult({ stopReason: "stop", text: input.text }))
      yield* projectTodoUpdates.offer({
        sessionId,
        projectPath: location.projectPath,
        text: input.text,
      });
    return toJsonValue({
      ok: true,
      command,
      status: "deferred",
      messageId,
      threadId,
      delivery,
      resultDelivery,
      expectsResponse: false,
    });
  }
  const inputs = yield* TaskInputStorage;
  const refs = yield* inputs.authorizeForward(sessionId, input.inputRefs ?? [], targetSessionId);
  const attachments = yield* prepareTaskInputs(
    targetSessionId,
    false,
    refs.map((reference) => ({ kind: "forwarded-input" as const, name: "Attachment", reference })),
  );
  if (
    !expectsResponse &&
    delivery !== "steer" &&
    !attachments.length &&
    input.outcome !== "blocked" &&
    (preparedRequests.some((request) => request.resultDelivery === "notification") ||
      (input.outcome !== "failed" && !preparedRequests.length && isReferenceNotification(encoded)))
  ) {
    yield* families.withNoticeDelivery(
      families.deferReferenceNotice(
        {
          id: messageId,
          recipientSessionId: targetSessionId,
          text: encoded,
        },
        preparedRequests.map((request) => request.turnId),
      ),
    );
    return toJsonValue({
      ok: true,
      command,
      status: "deferred",
      targetTitle: destinationSummary?.title ?? "Project Session",
      target: { sessionId: targetSessionId, workspacePath: destinationLocation.workingDirectory },
      messageId,
      threadId,
      delivery,
      expectsResponse: false,
      ...(replyToMessageId ? { replyToMessageId } : null),
      recipientContext: crossSessionContextSnapshot(destinationSnapshot.usage?.context),
    });
  }
  const turnId =
    delivery === "steer"
      ? yield* destination.steer(encoded, attachments, false)
      : delivery === "queue"
        ? yield* destination.followUp(encoded, attachments, false)
        : yield* destination.prompt(encoded, attachments, false);
  // Acceptance/queueing is not a durable response receipt. The worker confirms
  // it against the parent's transcript, retaining reports lost from the queue.
  for (const request of preparedRequests) yield* families.markNoticeAttempt(request.turnId, turnId);
  const pendingAfterSend =
    delivery === "queue"
      ? yield* destination.pendingMessages().pipe(Effect.catch(() => Effect.succeed(undefined)))
      : undefined;
  const queuedItem = pendingAfterSend?.items.find(
    (item) => item.crossSession?.messageId === messageId,
  );
  const queue =
    queuedItem && pendingAfterSend
      ? {
          itemId: queuedItem.itemId,
          lane: queuedItem.lane,
          position: queuedItem.position,
          length: pendingAfterSend.items.filter((item) => item.lane === queuedItem.lane).length,
        }
      : undefined;
  yield* catalogs.publish({
    _tag: "ProjectSessionChanged",
    sessionId: targetSessionId,
    projectPath: location.projectPath,
    workingDirectory: destinationLocation.workingDirectory,
    resolved: false,
  });
  return toJsonValue({
    ok: true,
    command,
    targetTitle: destinationSummary?.title ?? "Project Session",
    target: { sessionId: targetSessionId, workspacePath: destinationLocation.workingDirectory },
    messageId,
    threadId,
    turnId,
    delivery,
    expectsResponse,
    resultDelivery,
    ...(replyToMessageId ? { replyToMessageId } : null),
    status: delivery === "queue" ? "queued" : "accepted",
    recipientContext: crossSessionContextSnapshot(destinationSnapshot.usage?.context),
    ...(queue ? { queue } : null),
  });
}, Effect.mapError(routingError));
