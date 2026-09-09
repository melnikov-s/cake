import { DateTime, Effect, Schedule, Stream } from "effect";
import * as projectSessionMetadata from "../project-sessions/projectSessionMetadata";
import * as projectSessionOperations from "../project-sessions/projectSessionOperations";
import {
  ScheduledMessageError,
  type ScheduleMessageInput,
  type ScheduledMessage,
  type ScheduledMessageUpdate,
} from "./scheduled-message-data";
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

export const schedule = Effect.fn("ScheduledMessages.schedule")(function* (
  input: ScheduleMessageInput,
) {
  yield* projectSessionMetadata
    .inspect({ sessionId: input.targetSessionId })
    .pipe(asError("schedule"));
  const now = DateTime.formatIso(yield* DateTime.now);
  if (input.sendAt <= now)
    return yield* new ScheduledMessageError({
      operation: "schedule",
      message: "Scheduled send time must be in the future",
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

const deliverOne = Effect.fn("ScheduledMessages.deliverOne")(function* (message: ScheduledMessage) {
  yield* projectSessionOperations.sendAutomatically({
    sessionId: message.targetSessionId,
    text: message.text,
    attachments: [],
    renderUserMessageAsMarkdown: false,
  });
  const messages = yield* ScheduledMessages;
  yield* messages
    .transact((current) => Effect.succeed(current.filter((item) => item.id !== message.id)))
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
