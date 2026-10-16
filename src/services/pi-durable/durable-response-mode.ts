import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, InboxItem } from "@earendil-works/pi-durable";
import type { ConversationResponseMode } from "../../contracts/conversations/response-mode-reminders";
import { durableInputPresentation, type DurableInputResponse } from "./durable-input-presentation";

// Committed history is newest first; only a short tail is read per admission.
const HISTORY_SCAN_LIMIT = 64;

const contentText = (content: string | ReadonlyArray<{ type: string; text?: string }>) =>
  typeof content === "string"
    ? content
    : content
        .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
        .join("\n");

/**
 * The response mode of the newest Cake input the model will have seen before this one:
 * queued inbox input first (steering sees only the steering lane), then committed history.
 * Every Cake input records its effective mode, so the newest one decides; the durable
 * store is the authority, which keeps the mode correct across restarts and dedup.
 */
export async function previousDurableResponseMode(
  root: Pick<Conversation, "entries">,
  inbox: readonly InboxItem[],
  delivery: "prompt" | "steer" | "follow-up",
): Promise<ConversationResponseMode> {
  const queued = inbox.filter(
    (item): item is Extract<InboxItem, { content: unknown }> =>
      item.mode !== "write" && (delivery !== "steer" || item.mode === "steer"),
  );
  for (const item of queued.toReversed()) {
    const mode = durableInputPresentation(contentText(item.content)).responseMode;
    if (mode) return mode;
  }
  const page = await root.entries({}, HISTORY_SCAN_LIMIT, undefined, BACKGROUND_CONTEXT);
  for (const entry of page.items) {
    if (entry.kind !== "pi.user") continue;
    for (const message of (entry.model ?? []).toReversed()) {
      if (message.role !== "user") continue;
      const mode = durableInputPresentation(contentText(message.content)).responseMode;
      if (mode) return mode;
    }
  }
  return "text";
}

/**
 * Decide what a new input records. An explicit mode adds guidance only on a transition,
 * like Project Sessions; an input with no mode (worker reports, cross-session messages)
 * keeps the conversation's current mode without adding guidance.
 */
export function durableInputResponse(
  previous: ConversationResponseMode,
  requested: ConversationResponseMode | undefined,
): DurableInputResponse {
  const mode = requested ?? previous;
  return { mode, remind: mode !== previous };
}
