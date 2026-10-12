import { Effect } from "effect";
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
import type { PiQueuedMessages } from "../../services/pi/conversation-data";
import { encodeCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
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
 * recipient. Auxiliary profiles never raise renderer requests.
 */
export const bindRenderer = Effect.fn("SessionChats.bindRenderer")(function* (
  sessionId: string,
  connectionId: number,
) {
  const handle = yield* acquire(sessionId);
  const target =
    handle.profile === "ProjectSession"
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
  delivery: "prompt" | "steer" | "follow-up",
) {
  const handle = yield* acquire(input.sessionId);
  if (handle.profile !== "CakeChatSession" && input.crossSession)
    yield* inheritTaskInputProtection(input.crossSession.sender.sessionId, input.sessionId).pipe(
      asError("deliver"),
    );
  const message =
    handle.profile === "CakeChatSession"
      ? yield* prepareCoordinatorMessage(input).pipe(asError("deliver"))
      : input;
  const text = message.crossSession
    ? encodeCrossSessionMessage(message.text, message.crossSession)
    : message.text;
  const turnId = TurnId.make(
    yield* deliverConversation(
      Effect.succeed(handle),
      delivery,
      text,
      projectAttachments(
        yield* prepareTaskInputs(
          input.sessionId,
          handle.profile === "CakeChatSession",
          message.attachments,
        ).pipe(asError("deliver")),
      ),
      input.renderUserMessageAsMarkdown,
      input.presentationMode,
      input.responseMode,
    ).pipe(asError("deliver")),
  );
  yield* handle.publishSessionChanged().pipe(asError("deliver"));
  return turnId;
});

export const abort = Effect.fn("SessionChats.abort")(function* (target: SessionChatTarget) {
  yield* abortConversation(acquire(target.sessionId)).pipe(asError("abort"));
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

export const inspect = Effect.fn("SessionChats.inspect")(function* (
  input: SessionChatTarget & SessionInspectionQuery,
) {
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
