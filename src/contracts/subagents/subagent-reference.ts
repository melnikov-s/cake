import { Option, Schema } from "effect";

/** Public worker identity. A private Pi session ID is never a navigation target. */
export const SubagentReference = Schema.Struct({
  parentSessionId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isTrimmed(),
  ),
  handleId: Schema.String.check(Schema.isUUID(4)),
  messageId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isTrimmed()),
  ),
});
export interface SubagentReference extends Schema.Schema.Type<typeof SubagentReference> {}

export function subagentLink(
  parentSessionId: string,
  handleId: string,
  messageId?: string,
): string {
  const conversation = `cake://subagent/${encodeURIComponent(parentSessionId)}/${encodeURIComponent(handleId)}`;
  return messageId ? `${conversation}?message=${encodeURIComponent(messageId)}` : conversation;
}

export function parseSubagentLink(reference: string): SubagentReference | undefined {
  try {
    const url = new URL(reference);
    if (url.protocol !== "cake:" || url.hostname !== "subagent" || url.hash) return;
    if ([...url.searchParams.keys()].some((key) => key !== "message")) return;
    if (url.searchParams.getAll("message").length > 1) return;
    const segments = url.pathname.slice(1).split("/");
    if (segments.length !== 2) return;
    const parsed = Schema.decodeUnknownOption(SubagentReference)({
      parentSessionId: decodeURIComponent(segments[0]!),
      handleId: decodeURIComponent(segments[1]!),
      ...(url.searchParams.has("message") ? { messageId: url.searchParams.get("message") } : null),
    });
    return Option.getOrUndefined(parsed);
  } catch {
    return undefined;
  }
}
