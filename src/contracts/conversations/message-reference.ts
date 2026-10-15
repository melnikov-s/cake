import { Schema } from "effect";
import { TaskInputReference } from "./task-input";
import type { JsonValue } from "../serialization/json-contract";

const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Pi entry IDs, not renderer part IDs or cross-session delivery IDs. */
export function messageReference(sessionId: string, entryId: string): string {
  return `cake://session/${encodeURIComponent(sessionId)}?message=${encodeURIComponent(entryId)}`;
}

export function attachmentLink(sessionId: string, attachmentId: string): string {
  return `cake://session/${encodeURIComponent(sessionId)}?attachment=${encodeURIComponent(attachmentId)}`;
}

export function sessionLink(sessionId: string, messageId?: string, attachmentId?: string): string {
  if (attachmentId !== undefined) return attachmentLink(sessionId, attachmentId);
  return messageId === undefined
    ? `cake://session/${encodeURIComponent(sessionId)}`
    : messageReference(sessionId, messageId);
}

/** Shared by Markdown navigation and exact reference decoding. */
export function parseSessionLink(
  reference: string,
): { sessionId: string; messageId?: string; attachmentId?: string } | undefined {
  try {
    const url = new URL(reference);
    if (
      url.protocol !== "cake:" ||
      url.hostname !== "session" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return undefined;
    const sessionId = decodeURIComponent(url.pathname.slice(1));
    if (!sessionId || sessionId.includes("/") || sessionId.length > 256) return undefined;
    const keys = [...url.searchParams.keys()];
    if (keys.length === 0) return { sessionId };
    if (keys.length !== 1) return undefined;
    if (keys[0] === "attachment") {
      const attachmentId = url.searchParams.get("attachment");
      return attachmentId && Schema.is(TaskInputReference.fields.id)(attachmentId)
        ? { sessionId, attachmentId }
        : undefined;
    }
    if (keys[0] !== "message") return undefined;
    const messageId = url.searchParams.get("message");
    return messageId && messageId.length <= 256 ? { sessionId, messageId } : undefined;
  } catch {
    return undefined;
  }
}

export const MessageReference = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^cake:\/\/session\/[^/?#]+\?message=[^&#?]+$/),
  Schema.makeFilter((value) => parseSessionLink(value)?.messageId !== undefined),
);

export const messageRefsSchema = Schema.Array(MessageReference).check(Schema.isMaxLength(20));

export const MessageListInput = Schema.Struct({
  sessionId: id,
  branch: Schema.optionalKey(Schema.Literals(["active", "all"])),
  roles: Schema.optionalKey(
    Schema.Array(Schema.Literals(["user", "assistant", "toolResult", "bashExecution"])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
    ),
  ),
  offset: Schema.optionalKey(offset),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
});
export interface MessageListInput extends Schema.Schema.Type<typeof MessageListInput> {}

export const MessageReadInput = Schema.Struct({
  ref: MessageReference,
  offset: Schema.optionalKey(offset),
  maxChars: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20_000)),
  ),
});
export interface MessageReadInput extends Schema.Schema.Type<typeof MessageReadInput> {}

export const MessageOpenInput = Schema.Struct({ ref: MessageReference });
export interface MessageOpenInput extends Schema.Schema.Type<typeof MessageOpenInput> {}

/** Metadata only. No body previews, extracted attachment text, image bytes or storage paths. */
export const MessageMetadata = Schema.Struct({
  ref: MessageReference,
  link: MessageReference,
  sessionId: id,
  entryId: id,
  parentId: Schema.NullOr(id),
  timestamp: Schema.String,
  role: Schema.String,
  active: Schema.Boolean,
  inputRefs: Schema.Array(TaskInputReference).check(Schema.isMaxLength(20)),
  hasImages: Schema.Boolean,
});
export interface MessageMetadata extends Schema.Schema.Type<typeof MessageMetadata> {}

export const MessageListResult = Schema.Struct({
  sessionId: id,
  branch: Schema.Literals(["active", "all"]),
  total: offset,
  offset,
  nextOffset: Schema.NullOr(offset),
  messages: Schema.Array(MessageMetadata).check(Schema.isMaxLength(100)),
});
export interface MessageListResult extends Schema.Schema.Type<typeof MessageListResult> {}

export const MessageReadResult = Schema.Struct({
  message: MessageMetadata,
  text: Schema.String.check(Schema.isMaxLength(20_000)),
  totalChars: offset,
  offset,
  nextOffset: Schema.NullOr(offset),
  truncated: Schema.Boolean,
});
export interface MessageReadResult extends Schema.Schema.Type<typeof MessageReadResult> {}

/** Typed client-boundary decoder for the generic session inspection transport. */
export const decodeMessageReadResult = Schema.decodeUnknownSync(MessageReadResult);

export interface MessageOperationControl {
  list(input: MessageListInput, signal: AbortSignal): Promise<JsonValue>;
  read(input: MessageReadInput, signal: AbortSignal): Promise<JsonValue>;
  /** Decode the ref, then delegate to the existing invoking-window sessions.open gateway. */
  open(input: MessageOpenInput, signal: AbortSignal): Promise<JsonValue>;
}

export function messageNavigationTarget(ref: string) {
  const target = parseSessionLink(ref);
  if (!target?.messageId) throw new Error("Expected an exact Cake message reference");
  return { sessionId: target.sessionId, messageId: target.messageId };
}
