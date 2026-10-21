import { DateTime, Effect, Schedule, Stream } from "effect";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import * as projectSessionMetadata from "../project-sessions/projectSessionMetadata";
import * as projectSessionOperations from "../project-sessions/projectSessionOperations";
import * as cakeChatTargets from "../cake-chats/cakeChatTargets";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { deliverWhenAvailable } from "../conversations/conversations";
import { ApplicationState } from "../../services/storage/ApplicationState";
import {
  ScheduledMessageError,
  type ScheduleMessageInput,
  type ScheduledMessage,
  type ScheduledMessageUpdate,
} from "../../contracts/scheduled-messages/scheduled-message-data";
import {
  encodeScheduledMessage,
  scheduledMessageOrigin,
} from "../../contracts/conversations/scheduled-message-envelope";
import { ScheduledMessages } from "../../services/scheduled-messages/ScheduledMessages";

const asError = (operation: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new ScheduledMessageError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  );

export const initialize = Effect.fn("ScheduledMessages.initialize")(function* () {
  const messages = yield* ScheduledMessages;
  return yield* messages.initialize().pipe(asError("initialize"));
});

export const list = Effect.fn("ScheduledMessages.list")(function* (targetSessionId?: string) {
  const messages = yield* ScheduledMessages;
  const snapshot = messages.snapshot();
  return targetSessionId
    ? snapshot.messages.filter((message) => message.targetSessionId === targetSessionId)
    : snapshot.messages;
});

/** Permanent chats have stable addresses rather than Project Session transcripts. A Project
 * Chat is a valid destination only while its project is registered. */
const validateTarget = Effect.fn("ScheduledMessages.validateTarget")(function* (
  targetSessionId: string,
) {
  if (targetSessionId === CAKE_CHAT_SESSION_ID) return;
  if (isCakeChatSessionId(targetSessionId)) {
    const projects = (yield* ApplicationState).snapshot().projects;
    if (projects.some((project) => projectChatSessionId(project.path) === targetSessionId)) return;
    return yield* new ScheduledMessageError({
      operation: "schedule",
      message: "Project Chat belongs to no registered project",
    });
  }
  yield* projectSessionMetadata.inspect({ sessionId: targetSessionId }).pipe(asError("schedule"));
});

export const schedule = Effect.fn("ScheduledMessages.schedule")(function* (
  input: ScheduleMessageInput,
) {
  yield* validateTarget(input.targetSessionId);
  const now = DateTime.formatIso(yield* DateTime.now);
  if (input.sendAt <= now)
    return yield* new ScheduledMessageError({
      operation: "schedule",
      message: "Scheduled send time must be in the future",
    });
  if (input.repeatUntil !== undefined && Date.parse(input.repeatUntil) < Date.parse(input.sendAt))
    return yield* new ScheduledMessageError({
      operation: "schedule",
      message: "repeatUntil must not be earlier than the first send time",
    });
  const message: ScheduledMessage = {
    id: crypto.randomUUID(),
    targetSessionId: input.targetSessionId,
    text: input.text.trim(),
    sendAt: input.sendAt,
    createdAt: now,
  };
  if (input.createdBySessionId !== undefined)
    Object.assign(message, { createdBySessionId: input.createdBySessionId });
  if (input.repeatEverySeconds !== undefined)
    Object.assign(message, { repeatEverySeconds: input.repeatEverySeconds });
  if (input.repeatEverySeconds !== undefined && input.repeatUntil !== undefined)
    Object.assign(message, { repeatUntil: input.repeatUntil });
  const messages = yield* ScheduledMessages;
  yield* messages
    .transact((current) => Effect.succeed([...current, message]))
    .pipe(asError("schedule"));
  return message;
});

export const cancel = Effect.fn("ScheduledMessages.cancel")(function* (id: string) {
  const messages = yield* ScheduledMessages;
  let removed = false;
  yield* messages
    .transact((current) => {
      removed = current.some((message) => message.id === id);
      return Effect.succeed(current.filter((message) => message.id !== id));
    })
    .pipe(asError("cancel"));
  if (!removed)
    return yield* new ScheduledMessageError({
      operation: "cancel",
      message: "Cake could not find that scheduled message",
    });
});

export const observe = Effect.fn("ScheduledMessages.observe")(function* (targetSessionId: string) {
  const messages = yield* ScheduledMessages;
  return messages.changes().pipe(
    Stream.map((snapshot) => ({
      revision: snapshot.revision,
      messages: snapshot.messages.filter((message) => message.targetSessionId === targetSessionId),
    })),
    Stream.mapAccum<
      { revision: number; previous: ReadonlyArray<ScheduledMessage> | undefined },
      { revision: number; messages: ReadonlyArray<ScheduledMessage> },
      ScheduledMessageUpdate
    >(
      () => ({ revision: 0, previous: undefined }),
      (state, current) => {
        const nextRevision = state.revision + 1;
        if (state.previous === undefined) {
          const update: ScheduledMessageUpdate = {
            _tag: "Snapshot",
            revision: nextRevision,
            messages: current.messages,
          };
          return [{ revision: nextRevision, previous: current.messages }, [update]];
        }
        const previousById = new Map(state.previous.map((message) => [message.id, message]));
        const currentById = new Map(current.messages.map((message) => [message.id, message]));
        const events: ScheduledMessageUpdate[] = [];
        let revision = state.revision;
        for (const message of current.messages) {
          if (previousById.get(message.id) === message) continue;
          revision += 1;
          events.push({
            _tag: "Event",
            revision,
            event: { _tag: "Upserted", message },
          });
        }
        for (const message of state.previous) {
          if (currentById.has(message.id)) continue;
          revision += 1;
          events.push({ _tag: "Event", revision, event: { _tag: "Removed", id: message.id } });
        }
        return [{ revision, previous: current.messages }, events];
      },
    ),
  );
});

/** The first interval boundary after `now`, skipping boundaries missed while Cake was closed. */
const nextSendAt = (message: ScheduledMessage, now: number) => {
  if (message.repeatEverySeconds === undefined) return undefined;
  const interval = message.repeatEverySeconds * 1_000;
  const previous = Date.parse(message.sendAt);
  const next = previous + (Math.floor(Math.max(0, now - previous) / interval) + 1) * interval;
  if (message.repeatUntil !== undefined && next > Date.parse(message.repeatUntil)) return undefined;
  return new Date(next).toISOString();
};

/** A scheduled message is not user input: it starts or follows the target's work directly and
 * never carries passive notices that wait for the user's next message. */
const deliverToChat = Effect.fn("ScheduledMessages.deliverToChat")(function* (
  sessionId: string,
  text: string,
) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* cakeChatTargets.acquireAvailable(sessionId);
      yield* deliverWhenAvailable(Effect.succeed(handle), text, [], false);
      yield* handle.publishSessionChanged();
    }),
  );
});

const deliverOne = Effect.fn("ScheduledMessages.deliverOne")(function* (message: ScheduledMessage) {
  const text = encodeScheduledMessage(message.text, scheduledMessageOrigin(message));
  if (isCakeChatSessionId(message.targetSessionId))
    yield* deliverToChat(message.targetSessionId, text);
  else
    yield* projectSessionOperations.sendAutomatically({
      sessionId: message.targetSessionId,
      text,
      attachments: [],
      renderUserMessageAsMarkdown: false,
    });
  const next = nextSendAt(message, DateTime.toEpochMillis(yield* DateTime.now));
  const messages = yield* ScheduledMessages;
  // A cancellation during delivery removed the message; a repeat never re-adds it.
  yield* messages
    .transact((current) =>
      Effect.succeed(
        current.flatMap((item) =>
          item.id !== message.id ? [item] : next ? [{ ...item, sendAt: next }] : [],
        ),
      ),
    )
    .pipe(asError("deliver"));
});

const deliverDue = Effect.fn("ScheduledMessages.deliverDue")(function* () {
  const now = DateTime.formatIso(yield* DateTime.now);
  const due = (yield* list()).filter((message) => message.sendAt <= now);
  yield* Effect.forEach(
    due,
    (message) =>
      deliverOne(message).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Scheduled message delivery failed", error).pipe(
            Effect.annotateLogs({ scheduledMessageId: message.id }),
          ),
        ),
        Effect.ignore,
      ),
    { concurrency: 4, discard: true },
  );
});

export const runWorker = deliverDue().pipe(Effect.repeat(Schedule.spaced("1 second")));
