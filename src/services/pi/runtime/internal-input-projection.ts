import { Option, Schema } from "effect";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { InternalInput } from "../../../contracts/conversations/internal-input";
import type { UiPart } from "../../../contracts/conversations/session-contract";

export const internalInputEntryType = "cake.internal-input/v1";
/** Written before Pi persists the immediately following user-transport message. */
const InternalInputEntry = Schema.Struct({
  timestamp: Schema.Number,
  origin: InternalInput,
});

/** A marker applies to one following transport message, not every identical string/timestamp. */
export function internalInputOrigins(entries: readonly SessionEntry[]) {
  const origins = new Map<string, InternalInput>();
  let pending: typeof InternalInputEntry.Type | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === internalInputEntryType) {
      pending = Option.getOrUndefined(Schema.decodeUnknownOption(InternalInputEntry)(entry.data));
    } else if (entry.type === "message" || entry.type === "custom_message") {
      if (
        entry.type === "message" &&
        entry.message.role === "user" &&
        pending?.timestamp === entry.message.timestamp
      )
        origins.set(entry.id, pending.origin);
      pending = undefined;
    }
  }
  return origins;
}

/** Stable sender-authored messages, independent of their user/timer transport and replay IDs. */
export function passiveNoticeParts(origin?: InternalInput): UiPart[] {
  if (origin?._tag !== "UserWithReminders" && origin?._tag !== "UpdateBatch") return [];
  return origin.notices.map((notice) => ({
    id: `passive-${notice.id}`,
    renderKey: `passive-${notice.id}`,
    kind: "text",
    role: "user",
    text: notice.text,
    renderAs: "markdown",
    status: "complete",
    crossSession: notice.crossSession,
  }));
}

export type AutomaticInput = Exclude<InternalInput, { _tag: "UserWithReminders" }>;

/** Application-admitted input (no user text): a worker report, batched updates or Workboard entries. */
export function isAutomaticInput(origin?: InternalInput): origin is AutomaticInput {
  return origin !== undefined && origin._tag !== "UserWithReminders";
}

/** Transcript title of a worker report, and the custom-message type of reports in older transcripts. */
export const subagentCompletionType = "cake.subagent-completion";

/** The consumed worker report as transcript context, never as user-authored text. */
export function subagentCompletionPart(id: string, text: string): UiPart {
  return { id, kind: "context", title: subagentCompletionType, text };
}

/**
 * A held automatic input is an ordinary queue row: it can be steered, sent now, reordered or
 * removed exactly like a user message, and shows in the queue rather than the transcript.
 */
export function queuedAutomaticInputPart(
  origin: AutomaticInput,
  row: Extract<UiPart, { kind: "text" }>,
): UiPart {
  const text =
    origin._tag === "WorkboardDelivery"
      ? `Workboard entries ${origin.sequences.map((sequence) => `#${sequence}`).join(", ")}`
      : origin._tag === "UpdateBatch"
        ? origin.notices.map((notice) => notice.text).join("\n\n") || "Batched updates"
        : row.text;
  return {
    ...row,
    text,
    ...(origin._tag === "UpdateBatch" && origin.notices.length
      ? { renderAs: "markdown" as const }
      : null),
    ...(row.queuedInput
      ? { queuedInput: { ...row.queuedInput, text, internal: origin._tag } }
      : null),
  };
}

export function internalInputPart(
  origin: Extract<InternalInput, { _tag: "WorkboardDelivery" }>,
  id: string,
): UiPart {
  return {
    id,
    kind: "context",
    title: "Workboard",
    text: `Coordination entries ${origin.sequences.map((sequence) => `#${sequence}`).join(", ")}. Application context, not a user request.`,
  };
}
