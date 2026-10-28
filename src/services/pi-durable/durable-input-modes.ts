import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, InboxItem } from "@earendil-works/pi-durable";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
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

const inputModes = (content: Parameters<typeof contentText>[0]) => {
  const input = durableInputPresentation(contentText(content));
  if (input.responseMode === undefined || input.presentationMode === undefined) return undefined;
  return { response: input.responseMode, presentation: input.presentationMode };
};

/**
 * Modes of the newest Cake input the model will have seen before this one:
 * queued inbox input first (steering sees only the steering lane), then committed history.
 * Every Cake input records its effective modes, so the durable store recovers them
 * across restarts without a second store or notices on presentation-only clicks.
 */
export async function previousDurableInputModes(
  root: Pick<Conversation, "entries">,
  inbox: readonly InboxItem[],
  delivery: "prompt" | "steer" | "follow-up",
): Promise<{ response: ConversationResponseMode; presentation: ProjectSessionPresentationMode }> {
  const queued = inbox.filter(
    (item): item is Extract<InboxItem, { content: unknown }> =>
      item.mode !== "write" && (delivery !== "steer" || item.mode === "steer"),
  );
  for (const item of queued.toReversed()) {
    const modes = inputModes(item.content);
    if (modes) return modes;
  }
  const page = await root.entries({}, HISTORY_SCAN_LIMIT, undefined, BACKGROUND_CONTEXT);
  for (const entry of page.items) {
    if (entry.kind !== "pi.user") continue;
    for (const message of (entry.model ?? []).toReversed()) {
      if (message.role !== "user") continue;
      const modes = inputModes(message.content);
      if (modes) return modes;
    }
  }
  return { response: "text", presentation: "normal" };
}

/** Recover sent artifact context from the SDK inbox/originals, not window visibility.
 * Older originals carry the transition in their injected block; new inputs also
 * record the effective boolean in their existing admission envelope. */
export async function previousDurableArtifactTarget(
  root: Pick<Conversation, "entries">,
  inbox: readonly InboxItem[],
  delivery: "prompt" | "steer" | "follow-up",
): Promise<boolean> {
  const queued = inbox.filter(
    (item): item is Extract<InboxItem, { content: unknown }> =>
      item.mode !== "write" && (delivery !== "steer" || item.mode === "steer"),
  );
  for (const item of queued.toReversed()) {
    const target = durableInputPresentation(contentText(item.content)).artifactTarget;
    if (target !== undefined) return target;
  }
  let cursor;
  do {
    const page = await root.entries({}, HISTORY_SCAN_LIMIT, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (entry.kind !== "pi.user") continue;
      for (const message of (entry.model ?? []).toReversed()) {
        if (message.role !== "user") continue;
        const target = durableInputPresentation(contentText(message.content)).artifactTarget;
        if (target !== undefined) return target;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

/** Inputs without an explicit mode (reports, cross-session messages) inherit it silently. */
export function durableInputResponse(
  previous: ConversationResponseMode,
  requested: ConversationResponseMode | undefined,
): DurableInputResponse {
  const mode = requested ?? previous;
  return { mode, remind: mode !== previous };
}
