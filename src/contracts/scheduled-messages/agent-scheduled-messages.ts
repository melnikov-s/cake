import { Schema } from "effect";
import { AgentListInput, agentListLabel, agentListPage } from "../agent/agent-list-data";
import { ScheduledMessage } from "./scheduled-message-data";

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
    messages: items.map(({ id, targetSessionId, sendAt, text }) => ({
      id,
      targetSessionId,
      sendAt,
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
