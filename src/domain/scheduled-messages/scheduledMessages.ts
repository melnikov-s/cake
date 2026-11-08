import { DateTime, Effect, Schedule, Stream } from "effect";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import * as projectSessionMetadata from "../project-sessions/projectSessionMetadata";
import * as projectSessionOperations from "../project-sessions/projectSessionOperations";
import * as cakeChatTargets from "../cake-chats/cakeChatTargets";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { CakeSessionRuntimes, type CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { parseScheduledMessage } from "../../contracts/conversations/scheduled-message-envelope";
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
  if (targetSessionId === CAKE_CHAT_SESSION_ID || targetSessionId === SESSION_ASSISTANT_ID) return;
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
  const message = messages.snapshot().messages.find((item) => item.id === id);
  if (!message)
    return yield* new ScheduledMessageError({
      operation: "cancel",
      message: "Cake could not find that scheduled message",
    });
  // Keep a durable cancellation intent until only this schedule's pending inputs are removed.
  // The delivery gate prevents admission racing past a completed cancellation.
  yield* messages.withDelivery(updateMessage(id, (item) => ({ ...item, cancelRequested: true })));
  yield* reconcile(message).pipe(asError("cancel"));
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

/** No fixed cadence or catch-up: the next interval starts at Pi consumption. */
const nextSendAt = (message: ScheduledMessage, consumedAt: number) => {
  if (message.repeatEverySeconds === undefined) return undefined;
  const next = consumedAt + message.repeatEverySeconds * 1_000;
  if (message.repeatUntil !== undefined && next > Date.parse(message.repeatUntil)) return undefined;
  return new Date(next).toISOString();
};

const updateMessage = Effect.fn("ScheduledMessages.updateMessage")(function* (
  id: string,
  transition: (message: ScheduledMessage) => ScheduledMessage | undefined,
) {
  yield* (yield* ScheduledMessages)
    .transact((current) =>
      Effect.succeed(
        current.flatMap((item) => {
          if (item.id !== id) return [item];
          const next = transition(item);
          return next ? [next] : [];
        }),
      ),
    )
    .pipe(asError("deliver"));
});

const acquireDeliveryTarget = Effect.fn("ScheduledMessages.acquireDeliveryTarget")(function* (
  sessionId: string,
) {
  // Revalidate permanent addresses too: a removed project must not be silently resurrected.
  yield* validateTarget(sessionId);
  return isCakeChatSessionId(sessionId)
    ? yield* cakeChatTargets.acquireAvailable(sessionId)
    : yield* projectSessionOperations.prepareAgentCommand({ sessionId });
});

const acknowledgeDelivery = Effect.fn("ScheduledMessages.acknowledgeDelivery")(function* (
  message: ScheduledMessage,
  consumedAt: number,
) {
  const next = nextSendAt(message, consumedAt);
  yield* updateMessage(message.id, (item) => {
    if (!next) return undefined; // Explicit one-shot, or the repeat's end boundary.
    const { pendingOccurrenceId: _, deliveryError: __, ...rest } = item;
    return { ...rest, sendAt: next };
  });
});

const reconcileInput = Effect.fn("ScheduledMessages.reconcileInput")(function* (
  message: ScheduledMessage,
  handle: CakeSessionHandle,
) {
  const queued = (yield* handle.pendingMessages()).items
    .flatMap((item) => {
      const scheduled = parseScheduledMessage(item.text);
      return scheduled?.origin.id === message.id ? [{ item, origin: scheduled.origin }] : [];
    })
    .sort((a, b) => a.origin.sendAt.localeCompare(b.origin.sendAt));
  if (message.cancelRequested) {
    for (const { item } of queued) yield* handle.removeQueuedMessage(item.partId ?? item.itemId);
    // Also withdraw an accepted input still preparing (not yet visible in Pi's queue).
    if (message.pendingOccurrenceId && handle.cancelScheduledInput)
      yield* handle.cancelScheduledInput(message.pendingOccurrenceId);
    yield* updateMessage(message.id, () => undefined);
    return;
  }
  // Adopt the oldest legacy occurrence with its exact input identity; coalesce only siblings
  // of this schedule. Never replace unrelated follow-ups or abort an executing tool/turn.
  if (!message.pendingOccurrenceId && queued[0]) {
    const { item, origin } = queued[0];
    message = {
      ...message,
      sendAt: origin.sendAt,
      pendingOccurrenceId: item.turnId ?? item.itemId,
    };
    const adopted = message;
    yield* updateMessage(message.id, () => adopted);
  }
  for (const { item } of queued) {
    if ((item.turnId ?? item.itemId) !== message.pendingOccurrenceId)
      yield* handle.removeQueuedMessage(item.partId ?? item.itemId);
    else if (item.lane !== "steering") yield* handle.steerQueuedMessage(item.partId ?? item.itemId);
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  if (!message.pendingOccurrenceId) {
    if (message.sendAt > now) return;
    message = { ...message, pendingOccurrenceId: crypto.randomUUID() };
    const pending = message;
    // Persist identity before touching Pi, including one-shots. A restart retries the same ID.
    yield* updateMessage(message.id, () => pending);
  }
  if (!handle.scheduledInputReceipt)
    return yield* new ScheduledMessageError({
      operation: "deliver",
      message: "Target has no Pi consumption acknowledgement",
    });
  const occurrenceId = message.pendingOccurrenceId;
  if (!occurrenceId)
    return yield* new ScheduledMessageError({
      operation: "deliver",
      message: "Missing persisted occurrence identity",
    });
  const receipt = yield* handle.scheduledInputReceipt(occurrenceId);
  if (receipt?.status === "consumed") {
    yield* acknowledgeDelivery(message, receipt.consumedAt);
    return;
  }
  if (receipt?.status === "canceled") {
    // Withdrawing an occurrence never silently re-injects it or restarts recurrence.
    yield* updateMessage(message.id, () => undefined);
    return;
  }
  if (receipt?.status === "failed")
    return yield* new ScheduledMessageError({ operation: "deliver", message: receipt.message });
  if (receipt?.status === "pending") return;
  yield* handle.submit({
    turnId: occurrenceId,
    text: encodeScheduledMessage(message.text, scheduledMessageOrigin(message)),
    // Pi treats steering as normal execution intake when idle, and safe-boundary steering
    // when active. Avoid a racy snapshot check and never promote other human inputs.
    delivery: "steer",
    attachments: [],
    markdown: false,
  });
  yield* handle.publishSessionChanged();
  // Idle Pi intake can already be consumed by now; observe its real receipt without
  // delaying status publication to the next worker pass (or waiting for its reply).
  const delivered = yield* handle.scheduledInputReceipt(occurrenceId);
  if (delivered?.status === "consumed") yield* acknowledgeDelivery(message, delivered.consumedAt);
});

const reconcile = Effect.fn("ScheduledMessages.reconcile")(function* (
  candidate: ScheduledMessage,
  existingOnly = false,
) {
  const messages = yield* ScheduledMessages;
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      // Future legacy schedules may inspect an already assembled queue, but must not open
      // or restore a resolved/idle target before their due time. Acquisition stays outside
      // the short cancellation/admission gate so an unavailable target cannot hold it.
      const handle = existingOnly
        ? yield* (yield* CakeSessionRuntimes)
            .acquireSession(candidate.targetSessionId)
            .pipe(
              Effect.catchTag("PiSessionError", (error) =>
                error.operation === "acquireSession" &&
                error.message.includes("has not been assembled")
                  ? Effect.succeed(undefined)
                  : Effect.fail(error),
              ),
            )
        : yield* acquireDeliveryTarget(candidate.targetSessionId);
      if (!handle) return;
      if (existingOnly) yield* validateTarget(candidate.targetSessionId);
      yield* messages.withDelivery(
        Effect.gen(function* () {
          const message = messages.snapshot().messages.find((item) => item.id === candidate.id);
          if (!message) return;
          yield* reconcileInput(message, handle);
          const latest = messages.snapshot().messages.find((item) => item.id === message.id);
          if (latest?.deliveryError)
            yield* updateMessage(message.id, (item) => {
              const { deliveryError: _, ...rest } = item;
              return rest;
            });
        }),
      );
    }),
  ).pipe(Effect.result);
  if (result._tag === "Failure") {
    const error = result.failure instanceof Error ? result.failure.message : String(result.failure);
    const current = messages.snapshot().messages.find((item) => item.id === candidate.id);
    if (current && current.deliveryError !== error)
      yield* updateMessage(candidate.id, (item) => ({ ...item, deliveryError: error }));
    return yield* Effect.fail(result.failure);
  }
});

const deliverDue = Effect.fn("ScheduledMessages.deliverDue")(function* (includeFuture = false) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const due = (yield* list()).filter(
    (message) =>
      includeFuture ||
      message.cancelRequested ||
      message.pendingOccurrenceId ||
      message.sendAt <= now,
  );
  yield* Effect.forEach(
    due,
    (message) =>
      reconcile(
        message,
        includeFuture &&
          !message.pendingOccurrenceId &&
          !message.cancelRequested &&
          message.sendAt > now,
      ).pipe(
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

export const runWorker = Effect.gen(function* () {
  // On restart also discover/coalesce old queue entries whose schedule already advanced.
  yield* deliverDue(true);
  return yield* deliverDue().pipe(Effect.repeat(Schedule.spaced("1 second")));
});
