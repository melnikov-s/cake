import type { ContextView } from "@earendil-works/pi-durable";
import { getCurrentSystemMessage } from "@earendil-works/pi-durable-ai/utils/transcript";
import { estimateMessageTokens } from "@earendil-works/pi-durable-ai/utils/estimate";
import type { SessionContextMetadata } from "../../contracts/conversations/session-context-metadata";
import { modelActivityMetadata } from "../../utils/session-context-cost";
import { withoutDurableInputPresentation } from "./durable-input-presentation";

/** The committed active head only; no originals scan, memory expansion or request preparation. */
export function durableContextMetadata(active: ContextView): SessionContextMetadata {
  const messages = active.messages.map((message) => withoutDurableInputPresentation(message));
  const system = getCurrentSystemMessage(messages);
  // Do not trust usage recorded before a context edit/reset. Count the actual
  // projected contents, including bounded memory text, instructions and tools.
  const estimatedTokens = messages.reduce(
    (sum, message) => sum + (message.role === "system" ? 0 : estimateMessageTokens(message)),
    system ? estimateMessageTokens(system) : 0,
  );
  const invalidated = active.entries.findLastIndex(
    (entry) => entry.head !== undefined || entry.edits !== undefined || entry.kind === "pi.system",
  );
  const { lastModelActivityAt } = modelActivityMetadata(messages);
  const { cacheObservation } = modelActivityMetadata(
    active.contributions.slice(invalidated + 1).flat(),
  );
  return {
    estimatedTokens,
    ...(lastModelActivityAt ? { lastModelActivityAt } : null),
    ...(cacheObservation ? { cacheObservation } : null),
  };
}
