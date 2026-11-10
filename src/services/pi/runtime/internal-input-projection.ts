import { Option, Schema } from "effect";
import { sessionDigestParts } from "../../../contracts/cake-chats/session-digest-reminder";
import { splitContextReminders } from "./session-context-reminders";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { InternalInput } from "../../../contracts/conversations/internal-input";
import type { UiPart } from "../../../contracts/conversations/session-contract";
import type { AgentUpdate } from "../../../contracts/conversations/agent-update";

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
  if (
    origin?._tag !== "UserWithReminders" &&
    origin?._tag !== "UpdateBatch" &&
    origin?._tag !== "AttentionItem"
  )
    return [];
  return [
    ...(origin.updates ?? []).map(agentUpdatePart),
    ...[
      ...(origin.reportNotices ?? []),
      ...(origin._tag === "AttentionItem" ? [] : origin.notices),
    ].map(
      (notice) =>
        ({
          id: `passive-${notice.id}`,
          renderKey: `passive-${notice.id}`,
          kind: "text",
          role: "user",
          text: notice.text,
          renderAs: "markdown",
          status: "complete",
          crossSession: notice.crossSession,
        }) as const,
    ),
  ];
}

/** Already-admitted quiet content remains visible even while its transport is queued. */
export function admittedIncomingParts(origin: InternalInput | undefined, text: string): UiPart[] {
  if (origin?._tag !== "UserWithReminders" && origin?._tag !== "UpdateBatch") return [];
  const digest = splitContextReminders(text).reminders.find(
    (item) => item.title === "Cake · session updates",
  );
  return [...(digest ? sessionDigestParts(digest.text) : []), ...passiveNoticeParts(origin)];
}

export function agentUpdatePart(update: AgentUpdate): UiPart {
  return {
    id: `agent-update-${update.id}`,
    renderKey: `agent-update-${update.id}`,
    kind: "text",
    role: "user",
    text: update.text,
    renderAs: "markdown",
    status: "complete",
    agentSource: update.source,
  };
}

export type AutomaticInput = Exclude<InternalInput, { _tag: "UserWithReminders" }>;

/** Application-admitted input (no user text): a worker report, batched updates, an opened
 * attention item or Workboard entries. */
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
 * removed exactly like a user message. Its transport stays in the queue; already-admitted
 * quiet batch contents are projected separately by admittedIncomingParts.
 */
export function queuedAutomaticInputPart(
  origin: AutomaticInput,
  row: Extract<UiPart, { kind: "text" }>,
): UiPart {
  const text =
    origin._tag === "AgentUpdate"
      ? origin.update.text
      : origin._tag === "WorkboardDelivery"
        ? `Workboard entries ${origin.sequences.map((sequence) => `#${sequence}`).join(", ")}`
        : origin._tag === "UpdateBatch"
          ? [
              ...(origin.updates ?? []).map((update) => update.text),
              ...[...(origin.reportNotices ?? []), ...origin.notices].map((notice) => notice.text),
            ].join("\n\n") || "Batched updates"
          : origin._tag === "AttentionItem"
            ? attentionItemLabel(origin)
            : row.text;
  return {
    ...row,
    text,
    ...(origin._tag === "AgentUpdate"
      ? { agentSource: origin.update.source, renderAs: "markdown" as const }
      : null),
    ...(origin._tag === "UpdateBatch" && origin.notices.length
      ? { renderAs: "markdown" as const }
      : null),
    ...(row.queuedInput
      ? { queuedInput: { ...row.queuedInput, text, internal: origin._tag } }
      : null),
  };
}

/** Names the opened to-do; its held reports are counted, not inlined. */
function attentionItemLabel(origin: Extract<AutomaticInput, { _tag: "AttentionItem" }>) {
  const reports = (origin.updates?.length ?? 0) + (origin.reportNotices?.length ?? 0);
  return `Needs attention: ${origin.title}${
    reports ? ` (+${reports} ${reports === 1 ? "report" : "reports"})` : ""
  }`;
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
