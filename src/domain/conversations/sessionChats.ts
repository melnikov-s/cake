import { consumeSelection, prepareForChat } from "../projects/projectTodos";
import {
  passiveNoticeContext,
  type StoredPassiveNotice,
} from "../../contracts/conversations/passive-notice";
import { resumeAfterUserInput } from "../session-families/workboardDeliveries";
import { takePassiveNotices } from "../session-families/updateBatches";
import * as messageReferences from "./messageReferences";
import { messageReference } from "../../contracts/conversations/message-reference";
import { toJsonValue } from "../../utils/to-json-value";
import type { AttachmentReadInput } from "../../contracts/conversations/attachment-reference-control";
import type { TurnStop } from "../../contracts/conversations/turn-stop";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { Effect } from "effect";
import * as cakeChatDigest from "../cake-chats/cakeChatDigest";
import {
  inheritTaskInputProtection,
  prepareCoordinatorMessage,
  prepareTaskInputs,
} from "./taskInputs";
import type { SessionInspectionQuery } from "../../contracts/conversations/session-query-data";
import type {
  ChatConfiguration,
  PiSettingUpdate,
} from "../../contracts/conversations/session-contract";
import {
  CakeSessionRuntimes,
  type CakeSessionHandle,
  type PiSessionError,
} from "../../services/pi/CakeSessionRuntimes";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import type { PiQueuedMessages } from "../../contracts/conversations/pending-message-data";
import { encodeCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import {
  addReferenceNotifications,
  isReferenceNotification,
  pendingReportPage,
  pendingReportPresentation,
} from "../../contracts/conversations/reference-notification";
import {
  TurnId,
  type SessionChatPromptInput,
  SessionChatError,
  type SessionChatTarget,
} from "../../contracts/conversations/conversation-data";
import {
  abort as abortConversation,
  applyConfiguration as applyConversationConfiguration,
  compact as compactConversation,
  deliver as deliverConversation,
  editMessage as editConversationMessage,
  projectAttachments,
  projectQueuedMessages,
  setFastMode as setConversationFastMode,
  setModel as setConversationModel,
  setPiSetting as setConversationPiSetting,
  setThinkingLevel as setConversationThinkingLevel,
  use as useConversation,
} from "./conversations";

const asError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new SessionChatError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    );

/** Acquires the Pi runtime profile already assembled by the owning session collection. */
const acquire = Effect.fn("SessionChats.acquire")(function* (sessionId: string) {
  const sessions = yield* CakeSessionRuntimes;
  return yield* sessions.acquireSession(sessionId).pipe(asError("acquire"));
});

/**
 * Deliberate primary-session submission updates its current renderer binding.
 * An eligible desktop controls subsequent device requests; browser submissions
 * cannot displace an existing desktop. Pending requests keep their dispatched
 * recipient. Discussion sidecars can request interviews; private workers cannot.
 */
export const bindRenderer = Effect.fn("SessionChats.bindRenderer")(function* (
  sessionId: string,
  connectionId: number,
) {
  const handle = yield* acquire(sessionId);
  const target =
    handle.profile === "ProjectSession" || handle.profile === "DiscussionSession"
      ? ({ _tag: "ProjectSession", sessionId } as const)
      : handle.profile === "CakeChatSession"
        ? ({ _tag: "CakeChatSession", sessionId } as const)
        : undefined;
  if (!target) return;
  const coordinator = yield* RendererRequestCoordinator;
  yield* coordinator.bind(target, connectionId).pipe(asError("bindRenderer"));
});

export const deliver = Effect.fn("SessionChats.deliver")(function* (
  input: SessionChatPromptInput,
  delivery: "fyi" | "prompt" | "steer" | "follow-up",
) {
  const handle = yield* acquire(input.sessionId);
  const primary = handle.profile === "CakeChatSession" || handle.profile === "ProjectSession";
  const storage = primary ? yield* SessionFamilyStorage : undefined;
  const admission = Effect.gen(function* () {
    if (handle.profile !== "CakeChatSession" && input.crossSession)
      yield* inheritTaskInputProtection(input.crossSession.sender.sessionId, input.sessionId).pipe(
        asError("deliver"),
      );
    const message =
      handle.profile === "CakeChatSession"
        ? yield* prepareCoordinatorMessage(input).pipe(asError("deliver"))
        : input;
    if (delivery === "fyi") {
      if (!storage || !message.crossSession || message.attachments.length)
        return yield* new SessionChatError({
          operation: "deliver",
          message:
            "FYIs require cross-session provenance and no attachments; forward message references in text instead",
        });
      yield* storage
        .deferPassiveNotice({
          id: message.crossSession.messageId,
          recipientSessionId: input.sessionId,
          text: message.text,
          crossSession: message.crossSession,
        })
        .pipe(asError("deliver"));
      return TurnId.make(message.crossSession.messageId);
    }
    // Only passive source notifications wait; explicit questions and deliberate steering still run.
    if (
      storage &&
      input.crossSession &&
      !input.attachments.length &&
      delivery !== "steer" &&
      isReferenceNotification(encodeCrossSessionMessage(input.text, input.crossSession))
    ) {
      yield* storage
        .deferReferenceNotice({
          id: input.crossSession.messageId,
          recipientSessionId: input.sessionId,
          text: encodeCrossSessionMessage(message.text, message.crossSession ?? input.crossSession),
        })
        .pipe(asError("deliver"));
      return TurnId.make(input.crossSession.messageId);
    }
    const references =
      storage &&
      !message.crossSession &&
      !(handle.profile === "ProjectSession" && /^[!/]/.test(message.text))
        ? ((yield* storage.state().pipe(asError("deliver"))).deferredReferences?.filter(
            (item) => item.recipientSessionId === input.sessionId,
          ) ?? [])
        : [];
    // A user message to Cake Chat yields any report-triggered run and carries the quiet inbox.
    const userMessage =
      primary &&
      !message.crossSession &&
      !(handle.profile === "ProjectSession" && /^[!/]/.test(message.text))
        ? yield* cakeChatDigest.prepareUserMessage(handle, message.text).pipe(asError("deliver"))
        : undefined;
    const reportPage = pendingReportPage(references);
    const prepared = message.crossSession
      ? { text: message.text }
      : yield* prepareForChat(input.sessionId, userMessage?.text ?? message.text).pipe(
          asError("deliver"),
        );
    const text = message.crossSession
      ? encodeCrossSessionMessage(message.text, message.crossSession)
      : addReferenceNotifications(prepared.text, reportPage, references.length);
    if (storage && !message.crossSession)
      yield* resumeAfterUserInput(input.sessionId).pipe(asError("deliver"));
    const carriesUpdates = Boolean(storage && !message.crossSession && !/^[!/]/.test(message.text));
    const passive: readonly StoredPassiveNotice[] = carriesUpdates
      ? yield* takePassiveNotices(handle, input.sessionId).pipe(asError("deliver"))
      : [];
    const attachments = projectAttachments(
      yield* prepareTaskInputs(
        input.sessionId,
        handle.profile === "CakeChatSession",
        message.attachments,
      ).pipe(asError("deliver")),
    );
    const reportPresentation = pendingReportPresentation(reportPage);
    const passiveTurnId = passive.length || reportPage.length ? crypto.randomUUID() : undefined;
    if (storage && passiveTurnId && passive.length)
      yield* storage.markPassiveNoticeAdmission(
        passive.map((notice) => notice.id),
        passiveTurnId,
      );
    const effectiveDelivery =
      userMessage?.interruptedReport && delivery === "steer" ? "follow-up" : delivery;
    const turnId = TurnId.make(
      yield* (
        passiveTurnId
          ? handle.submit({
              turnId: passiveTurnId,
              delivery: effectiveDelivery,
              text: passive.length ? `${text}\n\n${passiveNoticeContext(passive)}` : text,
              attachments,
              markdown: input.renderUserMessageAsMarkdown,
              internal: {
                _tag: "UserWithReminders",
                text,
                notices: passive,
                reportNotices: reportPresentation.notices,
                updates: reportPresentation.updates,
                userText: message.text,
              },
              ...(input.presentationMode ? { presentationMode: input.presentationMode } : null),
              ...(input.responseMode ? { responseMode: input.responseMode } : null),
            })
          : deliverConversation(
              Effect.succeed(handle),
              // Steering into the run that just yielded would have nothing left to steer.
              userMessage?.interruptedReport && delivery === "steer" ? "follow-up" : delivery,
              text,
              attachments,
              input.renderUserMessageAsMarkdown,
              input.presentationMode,
              input.responseMode,
            )
      ).pipe(asError("deliver")),
    );
    yield* consumeSelection(prepared).pipe(asError("deliver"));
    if (storage && passiveTurnId && passive.length)
      yield* storage.markPassiveNoticeAdmission(
        passive.map((notice) => notice.id),
        passiveTurnId,
        true,
      );
    if (userMessage?.digestIds.length)
      yield* (yield* SessionFamilyStorage)
        .removeDigest(userMessage.digestIds)
        .pipe(asError("deliver"));
    // Admission is not user-facing handling. Keep the obligation across omission/abort/restart.
    if (storage && reportPage.length)
      yield* storage
        .markReferenceAdmissions(reportPage.map((item) => item.id))
        .pipe(asError("deliver"));
    // The user's message carried the pending batch, so its timer is cancelled.
    if (storage && carriesUpdates)
      yield* storage.closeUpdateBatch(input.sessionId).pipe(asError("deliver"));
    yield* handle.publishSessionChanged().pipe(asError("deliver"));
    return turnId;
  });
  // Serialize preparation through durable admission, never a model answer.
  return yield* (storage ? storage.withNoticeDelivery(admission) : admission).pipe(
    asError("deliver"),
  );
});

export const abort = Effect.fn("SessionChats.abort")(function* (
  target: SessionChatTarget & { readonly stop: TurnStop },
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage
    .withNoticeDelivery(
      Effect.gen(function* () {
        yield* storage.setBoardDeliveryPaused(target.sessionId, true);
      }),
    )
    .pipe(asError("abort"));
  yield* abortConversation(acquire(target.sessionId), target.stop).pipe(asError("abort"));
});

export const history = Effect.fn("SessionChats.history")(function* (
  input: SessionChatTarget & { readonly cursor: string },
) {
  const handle = yield* acquire(input.sessionId);
  if (!handle.history)
    return yield* new SessionChatError({
      operation: "history",
      message: "This conversation does not paginate history",
    });
  return yield* handle.history(input.cursor).pipe(asError("history"));
});

export const listQueuedMessages = Effect.fn("SessionChats.listQueuedMessages")(function* (
  target: SessionChatTarget,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.listQueuedMessages(),
  ).pipe(Effect.map(projectQueuedMessages), asError("listQueuedMessages"));
});

export const reorderQueuedMessage = Effect.fn("SessionChats.reorderQueuedMessage")(function* (
  input: SessionChatTarget & { readonly itemId: string; readonly position: number },
) {
  return yield* useConversation(acquire(input.sessionId), (handle) =>
    handle
      .reorderPendingMessage({ itemId: input.itemId, position: input.position })
      .pipe(Effect.andThen(() => handle.listQueuedMessages())),
  ).pipe(Effect.map(projectQueuedMessages), asError("reorderQueuedMessage"));
});

const withdrawQueuedMessages = Effect.fn("SessionChats.withdrawQueuedMessages")(function* (
  sessionId: string,
  selection: "all" | "steering" | { readonly partId: string },
  cancel: (handle: CakeSessionHandle) => Effect.Effect<PiQueuedMessages, PiSessionError>,
) {
  const handle = yield* acquire(sessionId);
  if (handle.profile !== "ProjectSession" && handle.profile !== "CakeChatSession")
    return projectQueuedMessages(yield* cancel(handle));
  const storage = yield* SessionFamilyStorage;
  // The outbox must not re-admit a report between Pi removing it and recording
  // the user's withdrawal. This gate never waits for a model response.
  return yield* storage.withNoticeDelivery(
    Effect.gen(function* () {
      const pending = (yield* handle.pendingMessages()).items.filter(
        (item) =>
          selection === "all" ||
          (selection === "steering" ? item.lane === "steering" : item.partId === selection.partId),
      );
      const result = yield* cancel(handle);
      const messageIds = pending.flatMap((item) =>
        item.crossSession ? [item.crossSession.messageId] : [],
      );
      if (messageIds.length) yield* storage.withdrawNotices(sessionId, messageIds);
      return projectQueuedMessages(result);
    }).pipe(Effect.uninterruptible),
  );
});

export const clearQueue = Effect.fn("SessionChats.clearQueue")(function* (
  target: SessionChatTarget,
) {
  return yield* withdrawQueuedMessages(target.sessionId, "all", (handle) =>
    handle.clearQueue(),
  ).pipe(asError("clearQueue"));
});

export const cancelSteering = Effect.fn("SessionChats.cancelSteering")(function* (
  target: SessionChatTarget,
) {
  return yield* withdrawQueuedMessages(target.sessionId, "steering", (handle) =>
    handle.cancelSteering(),
  ).pipe(asError("cancelSteering"));
});

export const removeQueuedMessage = Effect.fn("SessionChats.removeQueuedMessage")(function* (
  target: SessionChatTarget,
  partId: string,
) {
  return yield* withdrawQueuedMessages(target.sessionId, { partId }, (handle) =>
    handle.removeQueuedMessage(partId),
  ).pipe(asError("removeQueuedMessage"));
});

export const steerQueuedMessage = Effect.fn("SessionChats.steerQueuedMessage")(function* (
  target: SessionChatTarget,
  partId: string,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.steerQueuedMessage(partId),
  ).pipe(Effect.map(projectQueuedMessages), asError("steerQueuedMessage"));
});

export const sendQueuedMessageNow = Effect.fn("SessionChats.sendQueuedMessageNow")(function* (
  target: SessionChatTarget,
  partId?: string,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.sendQueuedMessageNow(partId),
  ).pipe(Effect.map(projectQueuedMessages), asError("sendQueuedMessageNow"));
});

export const queueCommand = Effect.fn("SessionChats.queueCommand")(function* (
  input: SessionChatTarget & { readonly command: string },
) {
  const handle = yield* acquire(input.sessionId);
  return yield* handle.queueCommand(input.command).pipe(asError("queueCommand"));
});

export const readAttachment = Effect.fn("SessionChats.readAttachment")(function* (
  input: SessionChatTarget & AttachmentReadInput,
) {
  const inputs = yield* TaskInputStorage;
  return yield* inputs.inspect(input.sessionId, input).pipe(asError("readAttachment"));
});

export const inspect = Effect.fn("SessionChats.inspect")(function* (
  input: SessionChatTarget & SessionInspectionQuery,
) {
  // Exact source views must also work for a producer that has never been opened
  // in this process. The message-reference domain owns catalog lookup/acquisition.
  if (input.kind === "messages-read")
    return toJsonValue(
      yield* messageReferences.read({
        ref: messageReference(input.sessionId, input.entryId ?? ""),
        offset: input.offset,
        maxChars: input.maxChars,
      }),
    );
  const handle = yield* acquire(input.sessionId);
  return yield* handle.inspectSession(input).pipe(asError("inspect"));
});

export const compact = Effect.fn("SessionChats.compact")(function* (
  target: SessionChatTarget,
  instructions?: string,
) {
  const handle = yield* acquire(target.sessionId);
  yield* compactConversation(Effect.succeed(handle), instructions).pipe(asError("compact"));
  yield* handle.publishSessionChanged().pipe(asError("compact"));
});

export const editMessage = Effect.fn("SessionChats.editMessage")(function* (
  input: SessionChatPromptInput & { readonly entryId: string },
) {
  const handle = yield* acquire(input.sessionId);
  yield* editConversationMessage(
    Effect.succeed(handle),
    input.entryId,
    input.text,
    projectAttachments(
      yield* prepareTaskInputs(
        input.sessionId,
        handle.profile === "CakeChatSession",
        input.attachments,
      ).pipe(asError("editMessage")),
    ),
    input.renderUserMessageAsMarkdown,
    input.presentationMode,
    input.responseMode,
  ).pipe(asError("editMessage"));
  yield* handle.publishSessionChanged().pipe(asError("editMessage"));
});

export const setUserMessageMarkdown = Effect.fn("SessionChats.setUserMessageMarkdown")(function* (
  target: SessionChatTarget,
  entryId: string,
  renderAsMarkdown: boolean,
) {
  yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.setUserMessageMarkdown(entryId, renderAsMarkdown),
  ).pipe(asError("setUserMessageMarkdown"));
});

export const applyConfiguration = Effect.fn("SessionChats.applyConfiguration")(function* (
  target: SessionChatTarget,
  configuration: ChatConfiguration,
) {
  yield* applyConversationConfiguration(acquire(target.sessionId), configuration).pipe(
    asError("applyConfiguration"),
  );
});

export const setModel = Effect.fn("SessionChats.setModel")(function* (
  target: SessionChatTarget,
  provider: string,
  modelId: string,
) {
  yield* setConversationModel(acquire(target.sessionId), provider, modelId).pipe(
    asError("setModel"),
  );
});

export const setThinkingLevel = Effect.fn("SessionChats.setThinkingLevel")(function* (
  target: SessionChatTarget,
  level: Parameters<CakeSessionHandle["setThinkingLevel"]>[0],
) {
  yield* setConversationThinkingLevel(acquire(target.sessionId), level).pipe(
    asError("setThinkingLevel"),
  );
});

export const setFastMode = Effect.fn("SessionChats.setFastMode")(function* (
  target: SessionChatTarget,
  enabled: boolean,
) {
  yield* setConversationFastMode(acquire(target.sessionId), enabled).pipe(asError("setFastMode"));
});

export const setPiSetting = Effect.fn("SessionChats.setPiSetting")(function* (
  target: SessionChatTarget,
  update: PiSettingUpdate,
) {
  yield* setConversationPiSetting(acquire(target.sessionId), update).pipe(asError("setPiSetting"));
});
