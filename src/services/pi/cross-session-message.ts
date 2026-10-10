import { Effect, Option, Schema } from "effect";

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const boundedLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Estimated Pi context occupancy captured at one point in time. */
export const CrossSessionContextSnapshot = Schema.Struct({
  usedTokens: Schema.NullOr(nonNegativeInt),
  windowTokens: Schema.NullOr(positiveInt),
});
export interface CrossSessionContextSnapshot extends Schema.Schema.Type<
  typeof CrossSessionContextSnapshot
> {}

/** Advisory position of one message in a live Pi delivery lane. */
export const CrossSessionQueueSnapshot = Schema.Struct({
  itemId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  lane: Schema.Literals(["steering", "follow-up"]),
  position: positiveInt,
  length: positiveInt,
});
export interface CrossSessionQueueSnapshot extends Schema.Schema.Type<
  typeof CrossSessionQueueSnapshot
> {}

export function crossSessionContextSnapshot(
  context: { readonly tokens: number | null; readonly contextWindow: number } | null | undefined,
): CrossSessionContextSnapshot {
  return {
    usedTokens: context?.tokens ?? null,
    windowTokens: context?.contextWindow ?? null,
  };
}

/** Cake routing metadata encoded into an ordinary Pi user message. */
export const CrossSessionMessageMetadata = Schema.Struct({
  version: Schema.Literal(1),
  messageId: Schema.String.check(Schema.isUUID(4)),
  threadId: Schema.String.check(Schema.isUUID(4)),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  expectsResponse: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  generatedNotice: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(CrossSessionContextSnapshot),
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
