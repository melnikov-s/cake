import { Effect } from "effect";
import * as subagents from "../subagents/subagents";
import type { ChatConfiguration, PiSettingUpdate } from "../../ipc/session-contract";
import { PiSessions, type PiSessionHandle } from "../../services/pi/PiSessions";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { encodeCrossSessionMessage } from "./cross-session-coordination";
import {
  TurnId,
  type SessionChatPromptInput,
  SessionChatError,
  type SessionChatTarget,
} from "./conversation-data";
import {
  abort as abortConversation,
  applyConfiguration as applyConversationConfiguration,
  authenticate as authenticateConversation,
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
  const sessions = yield* PiSessions;
  return yield* sessions.acquireSession(sessionId).pipe(asError("acquire"));
});

/**
 * Routes a primary session's renderer-facing UI requests to the prompting
 * window. Auxiliary profiles (Discussion and Subagent Sessions) never raise
 * renderer requests, so they have nothing to bind.
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
  const text = input.crossSession
    ? encodeCrossSessionMessage(input.text, input.crossSession)
    : input.text;
  const handle = yield* acquire(input.sessionId);
  const turnId = TurnId.make(
    yield* deliverConversation(
      Effect.succeed(handle),
      delivery,
      text,
      projectAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("deliver")),
  );
  yield* handle.publishSessionChanged().pipe(asError("deliver"));
  return turnId;
});

export const abort = Effect.fn("SessionChats.abort")(function* (target: SessionChatTarget) {
  yield* subagents.abortParentChildren(target.sessionId).pipe(asError("abort"));
  yield* abortConversation(acquire(target.sessionId)).pipe(asError("abort"));
});

export const listQueuedMessages = Effect.fn("SessionChats.listQueuedMessages")(function* (
  target: SessionChatTarget,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.listQueuedMessages(),
  ).pipe(Effect.map(projectQueuedMessages), asError("listQueuedMessages"));
});

export const clearQueue = Effect.fn("SessionChats.clearQueue")(function* (
  target: SessionChatTarget,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) => handle.clearQueue()).pipe(
    Effect.map(projectQueuedMessages),
    asError("clearQueue"),
  );
});

export const cancelSteering = Effect.fn("SessionChats.cancelSteering")(function* (
  target: SessionChatTarget,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.cancelSteering(),
  ).pipe(Effect.map(projectQueuedMessages), asError("cancelSteering"));
});

export const removeQueuedMessage = Effect.fn("SessionChats.removeQueuedMessage")(function* (
  target: SessionChatTarget,
  partId: string,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.removeQueuedMessage(partId),
  ).pipe(Effect.map(projectQueuedMessages), asError("removeQueuedMessage"));
});

export const steerQueuedMessage = Effect.fn("SessionChats.steerQueuedMessage")(function* (
  target: SessionChatTarget,
  partId: string,
) {
  return yield* useConversation(acquire(target.sessionId), (handle) =>
    handle.steerQueuedMessage(partId),
  ).pipe(Effect.map(projectQueuedMessages), asError("steerQueuedMessage"));
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
    projectAttachments(input.attachments),
    input.renderUserMessageAsMarkdown,
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
  level: Parameters<PiSessionHandle["setThinkingLevel"]>[0],
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

export const reload = Effect.fn("SessionChats.reload")(function* (target: SessionChatTarget) {
  yield* useConversation(acquire(target.sessionId), (handle) => handle.reload()).pipe(
    asError("reload"),
  );
});

export const login = Effect.fn("SessionChats.login")(function* (
  target: SessionChatTarget,
  provider: string,
  authType: "api_key" | "oauth",
) {
  yield* authenticateConversation(acquire(target.sessionId), {
    _tag: "Login",
    provider,
    authType,
  }).pipe(asError("login"));
});

export const logout = Effect.fn("SessionChats.logout")(function* (
  target: SessionChatTarget,
  provider: string,
) {
  yield* authenticateConversation(acquire(target.sessionId), { _tag: "Logout", provider }).pipe(
    asError("logout"),
  );
});
