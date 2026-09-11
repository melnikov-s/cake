import { Option, Schema } from "effect";
import { ScheduledMessage } from "./scheduled-message-data";

/** Cake-owned provenance carried by an ordinary Pi user message that a schedule delivered. */
export const ScheduledMessageOrigin = Schema.Struct({
  version: Schema.Literal(1),
  id: ScheduledMessage.fields.id,
  createdAt: ScheduledMessage.fields.createdAt,
  sendAt: ScheduledMessage.fields.sendAt,
  createdBySessionId: ScheduledMessage.fields.createdBySessionId,
});
export interface ScheduledMessageOrigin extends Schema.Schema.Type<typeof ScheduledMessageOrigin> {}

const prefix = "<cake-scheduled-message>";
const suffix = "</cake-scheduled-message>";

export function scheduledMessageOrigin(message: ScheduledMessage): ScheduledMessageOrigin {
  const origin: ScheduledMessageOrigin = {
    version: 1,
    id: message.id,
    createdAt: message.createdAt,
    sendAt: message.sendAt,
  };
  if (message.createdBySessionId !== undefined)
    return { ...origin, createdBySessionId: message.createdBySessionId };
  return origin;
}

export function encodeScheduledMessage(text: string, origin: ScheduledMessageOrigin) {
  const validated = Schema.decodeUnknownSync(ScheduledMessageOrigin)(origin);
  return `${prefix}${JSON.stringify(validated)}${suffix}\n\n${text}`;
}

export function parseScheduledMessage(
  content: string,
): { readonly text: string; readonly origin: ScheduledMessageOrigin } | undefined {
  if (!content.startsWith(prefix)) return undefined;
  const end = content.indexOf(suffix, prefix.length);
  if (end < 0) return undefined;
  try {
    const decoded = Schema.decodeUnknownOption(ScheduledMessageOrigin)(
      JSON.parse(content.slice(prefix.length, end)),
    );
    if (Option.isNone(decoded)) return undefined;
    return {
      origin: decoded.value,
      text: content
        .slice(end + suffix.length)
        .replace(/^\s*\n/, "")
        .trimStart(),
    };
  } catch {
    return undefined;
  }
}
