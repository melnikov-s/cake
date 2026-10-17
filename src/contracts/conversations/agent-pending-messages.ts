import { Schema } from "effect";
import type { JsonValue } from "../serialization/json-contract";
import { AgentListInput, agentListLabel, agentListPage } from "../agent/agent-list-data";
import { PiPendingMessages, PiPendingMessageReorder } from "./pending-message-data";

const target = { sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) };
export const AgentPendingListInput = Schema.Struct({ ...target, ...AgentListInput.fields });
export const AgentPendingReadInput = Schema.Struct({
  ...target,
  itemId: PiPendingMessageReorder.fields.itemId,
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxChars: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 }))),
});

function summary(item: PiPendingMessages["items"][number]) {
  return {
    itemId: item.itemId,
    ...(item.partId ? { partId: item.partId } : null),
    lane: item.lane,
    position: item.position,
    state: item.state,
    label: agentListLabel(item.text.replace(/\s+/g, " ")),
  };
}

export function agentPendingPage(value: JsonValue, input: AgentListInput) {
  const { items } = Schema.decodeUnknownSync(PiPendingMessages)(value);
  const query = input.query?.toLowerCase();
  const selected = items.filter((item) => !query || item.text.toLowerCase().includes(query));
  const page = agentListPage(selected, input);
  return { ...page, items: page.items.map(summary) };
}

export function agentPendingRead(value: JsonValue, input: typeof AgentPendingReadInput.Type) {
  const { items } = Schema.decodeUnknownSync(PiPendingMessages)(value);
  const item = items.find((entry) => entry.itemId === input.itemId);
  if (!item) throw new Error("Pending item is no longer available; refresh sessions.pending.");
  const offset = input.offset ?? 0;
  const end = offset + (input.maxChars ?? 4_000);
  return {
    ...summary(item),
    text: item.text.slice(offset, end),
    totalChars: item.text.length,
    offset,
    nextOffset: end < item.text.length ? end : null,
  };
}
