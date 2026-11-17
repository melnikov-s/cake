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
  type MessageMetadata,
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

/** Ownership locates the original; it does not authorize a caller to read its body. */
const subagentOriginalTarget = Effect.fn("MessageReferences.subagentOriginalTarget")(function* (
  ref: string,
  operation: "messages.read" | "messages.forward",
) {
  const worker = parseSubagentLink(ref);
  if (!worker?.messageId)
    return yield* new SessionChatError({
      operation,
      message: "Expected an exact public subagent message reference",
    });
  const available = yield* Effect.serviceOption(SubagentStorage);
  if (Option.isNone(available))
    return yield* new SessionChatError({
      operation,
      message: "Subagent source ownership is unavailable in this runtime",
    });
  const storage = available.value;
  const handleId = SubagentHandleId.make(worker.handleId);
  const saved = yield* storage.get(handleId);
  const history = saved ? undefined : yield* storage.history.get(handleId);
  const record = saved ?? history;
  if (!record || record.parentSessionId !== worker.parentSessionId)
    return yield* new SessionChatError({
      operation,
      message: "Unknown subagent handle or wrong parent for this exact source",
    });
  let sessionDirectory = history?.sessionDirectory ?? saved?.privateSessionDirectory;
  if (!sessionDirectory) {
    const environment = yield* Effect.serviceOption(SubagentEnvironment);
    if (Option.isNone(environment))
      return yield* new SessionChatError({
        operation,
        message: "The saved worker's original session directory is unavailable",
      });
    sessionDirectory = (yield* environment.value.location(record.workingDirectory))
      .sessionDirectory;
  }
  return {
    worker: { ...worker, messageId: worker.messageId },
    target: {
      sessionId: record.privateSessionId,
      workingDirectory: record.workingDirectory,
      sessionDirectory,
    },
  };
});

const publicSubagentMetadata = (
  worker: { readonly parentSessionId: string; readonly handleId: string },
  message: MessageMetadata,
): MessageMetadata => {
  const ref = subagentLink(worker.parentSessionId, worker.handleId, message.entryId);
  return { ...message, ref, link: ref, sessionId: worker.parentSessionId };
};

/** Exact metadata only: never read a body or substitute the parent's transcript/latest entry. */
export const describeSubagentOriginal = Effect.fn("MessageReferences.describeSubagentOriginal")(
  function* (ref: string) {
    const { worker, target } = yield* subagentOriginalTarget(ref, "messages.forward");
    const page = yield* PiMessageHistory.list(target, {
      sessionId: target.sessionId,
      branch: "all",
      entryId: worker.messageId,
      limit: 1,
    });
    const metadata = page.messages.find((message) => message.entryId === worker.messageId);
    if (!metadata)
      return yield* new SessionChatError({
        operation: "messages.forward",
        message: "The referenced Pi message does not exist in this subagent",
      });
    return publicSubagentMetadata(worker, metadata);
  },
);

/** Resolve a public worker source using persisted ownership even after release/restart. */
const readSubagentOriginal = Effect.fn("MessageReferences.readSubagentOriginal")(function* (
  input: MessageReadInput,
) {
  const { worker, target } = yield* subagentOriginalTarget(input.ref, "messages.read");
  const page = yield* PiMessageHistory.read(target, {
    entryId: worker.messageId,
    offset: input.offset,
    maxChars: input.maxChars,
  });
  return { ...page, message: publicSubagentMetadata(worker, page.message) };
});
