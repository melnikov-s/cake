import { createHash } from "node:crypto";
import type { UiPart } from "../../../contracts/conversations/session-contract";
import { shouldRenderMarkdown } from "../../../utils/markdown";
import { parseUserMessageEnvelope } from "./user-message-transport";

/** Display fields for a not-yet-consumed input; the raw queued text stays model-facing. */
export function queuedUserMessageDisplay(content: string, literalUserText = false) {
  const envelope = parseUserMessageEnvelope(content, literalUserText);
  return {
    text: envelope.text,
    renderAs:
      envelope.crossSession && shouldRenderMarkdown(envelope.text)
        ? ("markdown" as const)
        : undefined,
    crossSession: envelope.crossSession,
    scheduled: envelope.scheduled,
  };
}

export type QueuedMessageList = "steering" | "followUp" | "pending";

const queuedMessageLists: ReadonlyArray<{
  readonly list: QueuedMessageList;
  readonly idPrefix: string;
  readonly deliveryState: "steering" | "queued";
}> = [
  { list: "steering", idPrefix: "queued-steering", deliveryState: "steering" },
  { list: "followUp", idPrefix: "queued-follow-up", deliveryState: "queued" },
  { list: "pending", idPrefix: "queued-pending", deliveryState: "queued" },
];

/** Stable projected part ids aligned with the raw queue positions; empty texts have none. */
export function queuedMessageIds(
  idPrefix: string,
  deliveryState: "steering" | "queued",
  messages: readonly string[],
): Array<string | undefined> {
  const occurrences = new Map<string, number>();
  return messages.map((text) => {
    if (!text) return undefined;
    const occurrence = (occurrences.get(text) ?? 0) + 1;
    occurrences.set(text, occurrence);
    const digest = createHash("sha256")
      .update(`${deliveryState}\0${text}`)
      .digest("hex")
      .slice(0, 24);
    return `${idPrefix}-${digest}-${occurrence}`;
  });
}

export function projectQueuedMessages(
  steering: readonly string[],
  followUp: readonly string[],
  pending: readonly string[] = [],
): UiPart[] {
  const queues = { steering, followUp, pending };
  return queuedMessageLists.flatMap(({ list, idPrefix, deliveryState }) => {
    const messages = queues[list];
    return queuedMessageIds(idPrefix, deliveryState, messages).flatMap((id, index): UiPart[] => {
      if (id === undefined) return [];
      return [
        {
          id,
          kind: "text",
          role: "user",
          status: "complete",
          deliveryState,
          ...queuedUserMessageDisplay(messages[index]!),
        },
      ];
    });
  });
}

/** Resolves a projected queued part id back to its raw queue and position. */
export function locateQueuedMessage(
  partId: string,
  steering: readonly string[],
  followUp: readonly string[],
  pending: readonly string[] = [],
): { readonly list: QueuedMessageList; readonly index: number } | undefined {
  const queues = { steering, followUp, pending };
  for (const { list, idPrefix, deliveryState } of queuedMessageLists) {
    const index = queuedMessageIds(idPrefix, deliveryState, queues[list]).indexOf(partId);
    if (index >= 0) return { list, index };
  }
  return undefined;
}
