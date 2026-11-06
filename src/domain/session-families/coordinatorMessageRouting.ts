import * as projectTodoUpdates from "../projects/projectTodoUpdates";
import { appendMessageReferences } from "../../contracts/conversations/message-reference-forwarding";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import {
  immediateDelivery,
  type SessionMessageDelivery,
  SessionMessageDeliveryOptions,
} from "../../contracts/conversations/session-message-delivery";
import { isReferenceNotification } from "../../contracts/conversations/reference-notification";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { prepareCoordinatorNotice } from "../conversations/taskInputs";
import type { SessionCompletionReport } from "../../contracts/project-sessions/session-reporting";
import { toJsonValue } from "../../utils/to-json-value";
import { crossSessionContextSnapshot } from "../../contracts/conversations/cross-session-message";
import { substantiveTurnResult } from "../../contracts/pi/turn-result-data";
import { Effect, Schema } from "effect";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import * as chatTargets from "../cake-chats/cakeChatTargets";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
  type CrossSessionContextSnapshot,
} from "../../contracts/conversations/cross-session-message";
const failure = (message: string) =>
  new SessionFamilyStorageError({ operation: "familyLifecycle", message });

/** Routes the coordinator as a primary Cake destination, not a Project catalog entry. */
export const routeCoordinatorMessage = Effect.fn("SessionFamilies.routeCoordinatorMessage")(
  function* (
    sessionId: string,
    command: "sessions.send" | "sessions.reply",
    input: {
      sessionId?: string;
      text: string;
      delivery?: SessionMessageDelivery;
      threadId?: string;
      replyToMessageId?: string;
      resultDelivery?: ResultDelivery;
      inputRefs?: readonly string[];
      messageRefs?: readonly string[];
      outcome?: SessionCompletionReport["outcome"];
      resultKind?: "ready" | "investigation";
    },
    location: ProjectSessionLocation,
    senderContext?: CrossSessionContextSnapshot,
  ) {
    yield* Schema.decodeUnknownEffect(SessionMessageDeliveryOptions)(input).pipe(
      Effect.mapError((error) => failure(error.message)),
    );
    const storage = yield* SessionFamilyStorage;
    const state = yield* storage.state();
    const expectsResponse =
      input.delivery !== "fyi" && (input.resultDelivery ?? "notification") !== "ignore";
    const spawn = state.spawnedSessions.find((item) => item.sessionId === sessionId);
    // A session Cake Chat did not launch still answers Cake Chat's own requests to it.
    const owedCoordinator =
      !spawn && !(yield* storage.familyForMember(sessionId))
        ? state.turns.find(
            (turn) =>
              turn.sessionId === sessionId &&
              isCakeChatSessionId(turn.senderSessionId) &&
              !turn.reported &&
              (!input.threadId || input.threadId === turn.threadId) &&
              (!input.replyToMessageId || input.replyToMessageId === turn.requestMessageId),
          )
        : undefined;
    const requesterId = spawn?.requester.sessionId ?? owedCoordinator?.senderSessionId;
    // Omitted send targets mean global Cake Chat; replies follow their originating chat.
    const targetId =
      command === "sessions.reply" ? requesterId : (input.sessionId ?? CAKE_CHAT_SESSION_ID);
    if (!targetId || !isCakeChatSessionId(targetId)) return undefined;
    const sessions = yield* CakeSessionRuntimes;
    const executingIds = yield* sessions.executingTurnIds({
      sessionId,
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    });
    const pending =
      command === "sessions.reply" ||
      input.replyToMessageId ||
      (requesterId !== undefined && input.resultDelivery !== "reply")
        ? yield* storage.pendingResponseRequest(
            sessionId,
            executingIds,
            input.threadId,
            input.replyToMessageId,
          )
        : undefined;
    if (
      !pending &&
      command === "sessions.reply" &&
      spawn?.reportDelivered &&
      input.resultDelivery !== "reply" &&
      (input.threadId === undefined || input.threadId === spawn.sessionId) &&
      (input.replyToMessageId === undefined || input.replyToMessageId === spawn.sessionId)
    )
      return toJsonValue({ ok: true, command, status: "already-reported", expectsResponse: false });
    const messageText = appendMessageReferences(input.text, input.messageRefs ?? []);
    if (pending && pending.outcome === undefined && input.resultDelivery !== "reply") {
      if (!substantiveTurnResult({ stopReason: "stop", text: input.text }))
        return yield* failure(
          "A result report must contain substantive findings, changes, or a blocker—not an acknowledgment",
        );
      yield* storage.recordReport(pending.turnId, {
        outcome: input.outcome ?? "result",
        ...(input.resultKind ? { resultKind: input.resultKind } : null),
        text: messageText,
      });
      yield* projectTodoUpdates.offer({
        sessionId,
        projectPath: location.projectPath,
        text: input.text,
      });
      // Explicit input forwarding is delivered below rather than silently discarded.
      if (!input.inputRefs?.length)
        return toJsonValue({
          ok: true,
          command,
          status: "report-recorded",
          expectsResponse: false,
        });
    }
    const destination = yield* chatTargets.acquireAvailable(targetId);
    const snapshot = yield* destination.snapshot();
    const messageId = crypto.randomUUID();
    const replyToMessageId = pending?.requestMessageId ?? input.replyToMessageId;
    const metadata = {
      version: 1 as const,
      messageId,
      threadId: pending?.threadId ?? input.threadId ?? spawn?.sessionId ?? crypto.randomUUID(),
      sequence: 1,
      expectsResponse,
      resultDelivery:
        input.delivery === "fyi" ? ("ignore" as const) : (input.resultDelivery ?? "notification"),
      ...(replyToMessageId ? { replyToMessageId } : null),
      ...(senderContext ? { context: senderContext } : null),
      sender: {
        sessionId,
        title: `Session ${sessionId}`,
        kind: "project-session" as const,
        projectName: location.projectName,
        workingDirectory: location.workingDirectory,
      },
    };
    const encoded = yield* prepareCoordinatorNotice(
      targetId,
      encodeCrossSessionMessage(messageText, metadata),
    ).pipe(Effect.mapError((error) => failure(error.message)));
    if (replyToMessageId && pending)
      yield* storage.prepareResponse(
        sessionId,
        targetId,
        replyToMessageId,
        messageId,
        executingIds,
      );
    const attachments = input.inputRefs?.length
      ? yield* Effect.gen(function* () {
          const inputs = yield* TaskInputStorage;
          const grants = yield* inputs.authorizeForward(sessionId, input.inputRefs ?? [], targetId);
          return yield* inputs.grant(targetId, grants);
        })
      : [];
    if (
      !expectsResponse &&
      (!pending || pending.resultDelivery === "notification") &&
      input.delivery !== "steer" &&
      !attachments.length &&
      input.outcome !== "blocked" &&
      input.outcome !== "failed" &&
      isReferenceNotification(input.text)
    ) {
      yield* storage.withNoticeDelivery(
        Effect.gen(function* () {
          const requests = pending
            ? (yield* storage.state()).turns.filter((turn) =>
                turn.replyMessageIds?.includes(messageId),
              )
            : [];
          yield* storage.deferReferenceNotice(
            {
              id: messageId,
              recipientSessionId: targetId,
              text: encoded,
            },
            requests.map((request) => request.turnId),
          );
        }),
      );
      yield* projectTodoUpdates.offer({
        sessionId,
        projectPath: location.projectPath,
        text: input.text,
      });
      return toJsonValue({
        ok: true,
        command,
        status: "deferred",
        target: {
          kind: "cake-chat",
          ...(targetId === CAKE_CHAT_SESSION_ID ? null : { sessionId: targetId }),
        },
        targetTitle: targetId === CAKE_CHAT_SESSION_ID ? "Cake Chat" : "Project Chat",
        messageId,
        threadId: metadata.threadId,
        delivery: input.delivery ?? (snapshot.streaming ? "queue" : "prompt"),
        expectsResponse: false,
        recipientContext: crossSessionContextSnapshot(snapshot.usage?.context),
      });
    }
    const delivery = immediateDelivery(snapshot.streaming, input.delivery);
    if (delivery === "fyi") {
      const prepared = parseCrossSessionMessage(encoded);
      yield* storage.deferPassiveNotice({
        id: messageId,
        recipientSessionId: targetId,
        text: prepared?.text ?? input.text,
        crossSession: metadata,
      });
      if (substantiveTurnResult({ stopReason: "stop", text: input.text }))
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
        threadId: metadata.threadId,
        delivery,
        resultDelivery: "ignore",
        expectsResponse: false,
      });
    }
    const turnId =
      delivery === "steer"
        ? yield* destination.steer(encoded, attachments, false)
        : delivery === "queue"
          ? yield* destination.followUp(encoded, attachments, false)
          : yield* destination.prompt(encoded, attachments, false);
    if (replyToMessageId && pending)
      for (const request of (yield* storage.state()).turns)
        if (request.replyMessageIds?.includes(messageId))
          yield* storage.markNoticeAttempt(request.turnId, turnId);
    return toJsonValue({
      ok: true,
      command,
      target: {
        kind: "cake-chat",
        ...(targetId === CAKE_CHAT_SESSION_ID ? null : { sessionId: targetId }),
      },
      targetTitle: targetId === CAKE_CHAT_SESSION_ID ? "Cake Chat" : "Project Chat",
      status: delivery === "queue" ? "queued" : "accepted",
      delivery,
      turnId,
      messageId,
      threadId: metadata.threadId,
      expectsResponse: metadata.expectsResponse,
      resultDelivery: metadata.resultDelivery,
      recipientContext: crossSessionContextSnapshot(snapshot.usage?.context),
    });
  },
);
