import { Option, Schema } from "effect";

/** Public worker identity. A private Pi session ID is never a navigation target. */
export const SubagentReference = Schema.Struct({
  parentSessionId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isTrimmed(),
  ),
  handleId: Schema.String.check(Schema.isUUID(4)),
});
export interface SubagentReference extends Schema.Schema.Type<typeof SubagentReference> {}

export function subagentLink(parentSessionId: string, handleId: string): string {
  return `cake://subagent/${encodeURIComponent(parentSessionId)}/${encodeURIComponent(handleId)}`;
}

export function parseSubagentLink(reference: string): SubagentReference | undefined {
  try {
    const url = new URL(reference);
    if (url.protocol !== "cake:" || url.hostname !== "subagent" || url.search || url.hash) return;
    const segments = url.pathname.slice(1).split("/");
    if (segments.length !== 2) return;
    const parsed = Schema.decodeUnknownOption(SubagentReference)({
      parentSessionId: decodeURIComponent(segments[0]!),
      handleId: decodeURIComponent(segments[1]!),
    });
    return Option.getOrUndefined(parsed);
  } catch {
    return undefined;
  }
}
