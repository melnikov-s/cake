import { Option, Schema } from "effect";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

/** Cake-owned routing metadata carried by an ordinary Pi user message. */
export const CrossSessionMessageMetadata = Schema.Struct({
  version: Schema.Literal(1),
  messageId: Schema.String.check(Schema.isUUID(4)),
  threadId: Schema.String.check(Schema.isUUID(4)),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  sender: Schema.Struct({
    sessionId: boundedId,
    title: boundedLabel,
    kind: Schema.Literals(["project-session", "cake-chat"]),
    projectName: Schema.optionalKey(boundedLabel),
    workingDirectory: Schema.optionalKey(boundedPath),
  }),
  maxMessages: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  ),
});
export interface CrossSessionMessageMetadata extends Schema.Schema.Type<
  typeof CrossSessionMessageMetadata
> {}

export type CrossSessionDelivery = "prompt" | "queue" | "steer";

export type CrossSessionDeliveryStatus =
  | "accepted"
  | "queued"
  | "delivered"
  | "processing"
  | "answered"
  | "failed"
  | "canceled";

export interface CrossSessionDeliveryProjection {
  readonly messageState: "missing" | "queued" | "projected";
  readonly turnState: "unknown" | "active" | "complete" | "failed" | "aborted";
  readonly assistantResponseProjected: boolean;
}

/** Resolves Cake's delivery vocabulary from neutral facts about the Pi projection. */
export function deriveCrossSessionDeliveryStatus(
  delivery: CrossSessionDelivery,
  projection: CrossSessionDeliveryProjection,
): CrossSessionDeliveryStatus {
  if (projection.messageState === "queued") return "queued";
  if (projection.turnState === "failed") return "failed";
  if (projection.turnState === "aborted") return "canceled";
  if (projection.turnState === "complete")
    return projection.assistantResponseProjected ? "answered" : "delivered";
  if (projection.messageState === "projected" && projection.turnState === "active")
    return "processing";
  if (projection.messageState === "projected") return "delivered";
  return delivery === "queue" ? "queued" : "accepted";
}

export interface CoordinationMessage {
  readonly messageId: string;
  readonly senderSessionId: string;
  readonly targetSessionId: string;
  turnId: string;
  readonly delivery: CrossSessionDelivery;
  status: CrossSessionDeliveryStatus;
}

export interface CoordinationThread {
  readonly threadId: string;
  readonly participants: [string, string];
  readonly maxMessages?: number;
  readonly messages: CoordinationMessage[];
  state: "open" | "closed";
}

const prefix = "<cake-session-message>";
const suffix = "</cake-session-message>";

export function encodeCrossSessionMessage(text: string, metadata: CrossSessionMessageMetadata) {
  const validated = Schema.decodeUnknownSync(CrossSessionMessageMetadata)(metadata);
  return `${prefix}${JSON.stringify(validated)}${suffix}\n\n${text}`;
}

export function parseCrossSessionMessage(
  content: string,
): { readonly text: string; readonly metadata: CrossSessionMessageMetadata } | undefined {
  if (!content.startsWith(prefix)) return undefined;
  const end = content.indexOf(suffix, prefix.length);
  if (end < 0) return undefined;
  try {
    const decoded = Schema.decodeUnknownOption(CrossSessionMessageMetadata)(
      JSON.parse(content.slice(prefix.length, end)),
    );
    if (Option.isNone(decoded)) return undefined;
    return {
      metadata: decoded.value,
      text: content
        .slice(end + suffix.length)
        .replace(/^\s*\n/, "")
        .trimStart(),
    };
  } catch {
    return undefined;
  }
}
