import { Schema } from "effect";
import { AgentListInput, agentListLabel, agentListPage } from "../agent/agent-list-data";
import { ScheduleRepeatSeconds, ScheduledMessage } from "./scheduled-message-data";

const timestampInput = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** Agent-facing schedule request. The omitted target is the calling conversation itself. */
export const AgentScheduleInput = Schema.Struct({
  sessionId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description:
        "Target Project Session ID or suffix, cake-chat, or project-chat:<hash>. Omit to schedule to the calling conversation itself.",
    }),
  ),
  text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
  sendAt: Schema.optionalKey(
    timestampInput.annotate({ description: "First send time as an ISO timestamp." }),
  ),
  delaySeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31_536_000 })).annotate({
      description: "First send after this many seconds; use instead of sendAt.",
    }),
  ),
  repeatEverySeconds: Schema.optionalKey(
    ScheduleRepeatSeconds.annotate({
      description:
        "Repeat at this interval (60 to 604800 seconds) until cancelled or repeatUntil. Without sendAt/delaySeconds the first send is one interval from now.",
    }),
  ),
  repeatUntil: Schema.optionalKey(
    timestampInput.annotate({ description: "ISO timestamp after which a repeat stops." }),
  ),
});
export type AgentScheduleInput = typeof AgentScheduleInput.Type;

export const agentScheduleSummary =
  "Schedule a one-off or recurring message to yourself, Cake Chat, a Project Chat, or a Project Session; it wakes the target when due.";
export const agentScheduleGuidance = [
  "Omit sessionId to schedule to the calling conversation (a self-reminder or check-in); Cake Chat, Project Chats and Project Sessions all work. Other targets accept cake-chat, project-chat:<hash> or a Project Session reference.",
  "Give sendAt (ISO) or delaySeconds for a one-off. Add repeatEverySeconds for a recurring check-in (optional repeatUntil); it keeps one ID and one pending entry.",
  "Schedules survive restart. sessions.scheduled lists them; sessions.cancel-scheduled stops one, including a recurring check-in when its task finishes or the user pauses it.",
];

export const AgentScheduledListInput = Schema.Struct({
  ...AgentListInput.fields,
  sessionId: Schema.optionalKey(ScheduledMessage.fields.targetSessionId),
});
export const AgentScheduledReadInput = Schema.Struct({
  id: ScheduledMessage.fields.id,
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxChars: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 }))),
});

export function agentScheduledPage(messages: readonly ScheduledMessage[], input: AgentListInput) {
  const query = input.query?.toLowerCase();
  const selected = messages
    .filter((message) => !query || message.text.toLowerCase().includes(query))
    .toSorted((a, b) => a.sendAt.localeCompare(b.sendAt) || a.id.localeCompare(b.id));
  const { items, ...page } = agentListPage(selected, input);
  return {
    ...page,
    messages: items.map(({ id, targetSessionId, sendAt, repeatEverySeconds, text }) => ({
      id,
      targetSessionId,
      sendAt,
      ...(repeatEverySeconds === undefined ? null : { repeatEverySeconds }),
      label: agentListLabel(text.replace(/\s+/g, " ")),
    })),
  };
}

export function agentScheduledRead(
  messages: readonly ScheduledMessage[],
  input: typeof AgentScheduledReadInput.Type,
) {
  const message = messages.find((item) => item.id === input.id);
  if (!message)
    throw new Error("Scheduled message is no longer available; refresh sessions.scheduled.");
  const offset = input.offset ?? 0;
  const end = offset + (input.maxChars ?? 4_000);
  return {
    ...message,
    text: message.text.slice(offset, end),
    totalChars: message.text.length,
    offset,
    nextOffset: end < message.text.length ? end : null,
  };
}
