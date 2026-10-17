import { Schema } from "effect";

/** Agent discovery selects items; exact inspection supplies their details. */
export const AgentListInput = Schema.Struct({
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  query: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
export interface AgentListInput extends Schema.Schema.Type<typeof AgentListInput> {}

/** Apply domain filters and deterministic ordering before slicing the collection. */
export function agentListPage<T>(items: readonly T[], input: AgentListInput) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    total: items.length,
    offset,
    nextOffset: offset + page.length < items.length ? offset + page.length : null,
  };
}

/** Display labels may be shortened; routing identities must never use this helper. */
export function agentListLabel(value: string): string {
  return value.length > 256 ? `${value.slice(0, 255)}…` : value;
}
