import { Effect, Schema, Option } from "effect";
import { parseSubagentLink, subagentLink } from "../../contracts/subagents/subagent-reference";
import { SubagentHandleId } from "../../contracts/subagents/subagent-data";
import { SubagentStorage } from "../../services/storage/SubagentStorage";
import { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import {
  MessageListInput,
  MessageListResult,
  MessageReadInput,
  MessageReadResult,
  messageNavigationTarget,
} from "../../contracts/conversations/message-reference";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import * as PiMessageHistory from "../../services/pi/PiMessageHistory";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import * as sessionReferences from "../project-sessions/sessionReferences";
import {
  isCakeChatSessionId,
  cakeChatSideChatConversationId,
} from "../../contracts/cake-chats/cake-chat-identity";
import * as discussionSessionReferences from "../discussion-sessions/discussionSessionReferences";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";

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

const durableHandle = Effect.fn("MessageReferences.durableHandle")(function* (sessionId: string) {
  return yield* (yield* CakeSessionRuntimes).acquireSession(sessionId);
});

const isDurableTarget = (sessionId: string) =>
  isCakeChatSessionId(sessionId) || cakeChatSideChatConversationId(sessionId) !== undefined;

const projectMessageTarget = Effect.fn("MessageReferences.projectTarget")(function* (
  sessionId: string,
) {
  const location = yield* findLocation({ sessionId });
  return {
    sessionId,
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
  };
});

/** Resolve the target through the existing catalog; Pi remains the message authority. */
export const list = Effect.fn("MessageReferences.list")(
  function* (input: MessageListInput) {
    const decoded = yield* Schema.decodeUnknownEffect(MessageListInput)(input);
    const sessionId = isDurableTarget(decoded.sessionId)
      ? decoded.sessionId
      : yield* sessionReferences.resolve(decoded.sessionId);
    const value =
      cakeChatSideChatConversationId(sessionId) !== undefined
        ? yield* discussionSessionReferences.inspectMessages(sessionId, {
            ...decoded,
            kind: "messages-list",
          })
        : isCakeChatSessionId(sessionId)
          ? yield* (yield* durableHandle(sessionId)).inspectSession({
              ...decoded,
              kind: "messages-list",
            })
          : yield* PiMessageHistory.list(yield* projectMessageTarget(sessionId), decoded);
    return yield* Schema.decodeUnknownEffect(MessageListResult)(value);
  },
  Effect.scoped,
  asError("messages.list"),
);

/** No search or current-context fallback: the source entry must still exist in Pi. */
export const read = Effect.fn("MessageReferences.read")(
  function* (input: MessageReadInput) {
    const decoded = yield* Schema.decodeUnknownEffect(MessageReadInput)(input);
    const worker = parseSubagentLink(decoded.ref);
    if (worker?.messageId) return yield* readSubagentOriginal(decoded);
    const target = messageNavigationTarget(decoded.ref);
    const query = {
      offset: decoded.offset ?? 0,
      maxChars: decoded.maxChars ?? 4_000,
      entryId: target.messageId,
    };
    const value =
      cakeChatSideChatConversationId(target.sessionId) !== undefined
        ? yield* discussionSessionReferences.inspectMessages(target.sessionId, {
            ...query,
            kind: "messages-read",
          })
        : isCakeChatSessionId(target.sessionId)
          ? yield* (yield* durableHandle(target.sessionId)).inspectSession({
              ...query,
              kind: "messages-read",
            })
          : yield* PiMessageHistory.read(yield* projectMessageTarget(target.sessionId), query);
    return yield* Schema.decodeUnknownEffect(MessageReadResult)(value);
  },
  Effect.scoped,
  asError("messages.read"),
);

/** Resolve a public worker source using persisted ownership even after release/restart. */
const readSubagentOriginal = Effect.fn("MessageReferences.readSubagentOriginal")(function* (
  input: MessageReadInput,
) {
  const decoded = yield* Schema.decodeUnknownEffect(MessageReadInput)(input);
  const worker = parseSubagentLink(decoded.ref);
  if (!worker?.messageId)
    return yield* new SessionChatError({
      operation: "messages.read",
      message: "Expected an exact public subagent message reference",
    });
  const available = yield* Effect.serviceOption(SubagentStorage);
  if (Option.isNone(available))
    return yield* new SessionChatError({
      operation: "messages.read",
      message: "Subagent source ownership is unavailable in this runtime",
    });
  const storage = available.value;
  const handleId = SubagentHandleId.make(worker.handleId);
  const saved = yield* storage.get(handleId);
  const history = saved ? undefined : yield* storage.history.get(handleId);
  const record = saved ?? history;
  if (!record || record.parentSessionId !== worker.parentSessionId)
    return yield* new SessionChatError({
      operation: "messages.read",
      message: "Unknown subagent handle or wrong parent for this exact source",
    });
  let sessionDirectory = history?.sessionDirectory ?? saved?.privateSessionDirectory;
  if (!sessionDirectory) {
    const environment = yield* Effect.serviceOption(SubagentEnvironment);
    if (Option.isNone(environment))
      return yield* new SessionChatError({
        operation: "messages.read",
        message: "The saved worker's original session directory is unavailable",
      });
    sessionDirectory = (yield* environment.value.location(record.workingDirectory))
      .sessionDirectory;
  }
  const page = yield* PiMessageHistory.read(
    {
      sessionId: record.privateSessionId,
      workingDirectory: record.workingDirectory,
      sessionDirectory,
    },
    { entryId: worker.messageId, offset: decoded.offset, maxChars: decoded.maxChars },
  );
  const ref = subagentLink(worker.parentSessionId, worker.handleId, page.message.entryId);
  return {
    ...page,
    message: { ...page.message, ref, link: ref, sessionId: worker.parentSessionId },
  };
});
