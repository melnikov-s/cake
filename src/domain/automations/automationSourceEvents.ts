import { DateTime, Effect, Option } from "effect";
import type {
  AutomationEventKind,
  AutomationSourceEvent,
} from "../../contracts/automations/automation-data";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { AutomationEvents } from "../../services/automations/AutomationEvents";
import { SessionFamilyStorage, familyMember } from "../../services/storage/SessionFamilyStorage";

interface SourceInput {
  readonly event: AutomationEventKind;
  readonly eventId: string;
  readonly sessionId: string;
  readonly sourceMessageId?: string;
  readonly text?: string;
}

/** Optional integration for session runtimes used independently of the automation workflow. */
export const publishProjectSession = Effect.fn("Automations.publishProjectSession")(function* (
  input: SourceInput & { readonly projectPath: string },
) {
  const sink = yield* Effect.serviceOption(AutomationEvents);
  if (Option.isNone(sink)) return;
  const family = yield* (yield* SessionFamilyStorage).familyForMember(input.sessionId);
  const member = family && familyMember(family, input.sessionId);
  const event: AutomationSourceEvent = {
    eventId: input.eventId,
    event: input.event,
    occurredAt: DateTime.formatIso(yield* DateTime.now),
    sourceSessionId: input.sessionId,
    projectPath: input.projectPath,
    sourceKind:
      family && member
        ? member.parentSessionId === undefined
          ? "family-root"
          : "family-child"
        : "standalone-project-session",
  };
  if (input.sourceMessageId !== undefined)
    Object.assign(event, { sourceMessageId: input.sourceMessageId });
  if (input.text !== undefined) Object.assign(event, { text: input.text });
  yield* sink.value.publish(event);
});

export const publishChat = Effect.fn("Automations.publishChat")(function* (
  input: SourceInput & { readonly projectPath?: string },
) {
  const sink = yield* Effect.serviceOption(AutomationEvents);
  if (
    Option.isNone(sink) ||
    (input.projectPath === undefined && input.sessionId !== CAKE_CHAT_SESSION_ID)
  )
    return;
  const event: AutomationSourceEvent = {
    eventId: input.eventId,
    event: input.event,
    occurredAt: DateTime.formatIso(yield* DateTime.now),
    sourceSessionId: input.sessionId,
    sourceKind: input.projectPath === undefined ? "cake-chat" : "project-chat",
  };
  if (input.projectPath !== undefined) Object.assign(event, { projectPath: input.projectPath });
  if (input.sourceMessageId !== undefined)
    Object.assign(event, { sourceMessageId: input.sourceMessageId });
  if (input.text !== undefined) Object.assign(event, { text: input.text });
  yield* sink.value.publish(event);
});
