import { applySnapshot } from "r-state-tree";
import type { Conversation } from "../models/Conversation";
import { messageSnapshots } from "../reducers/SessionPartReducer";

/** A transient display projection, never a Pi transcript or evidence of runtime readiness. */
export function projectSessionForkPreview(
  source: Conversation,
  preview: Conversation,
  entryId: string,
) {
  const entries = new Map(source.tree.map((entry) => [entry.piId, entry]));
  const branch = new Set<string>();
  let current: string | undefined = entryId;
  while (current && !branch.has(current)) {
    branch.add(current);
    current = entries.get(current)?.parentPiId;
  }
  const parts = source.uiParts;
  const end = parts.findLastIndex((part) => "entryId" in part && part.entryId === entryId);
  // Inactive branches may only have some ancestors in the current display window.
  // Show those known originals rather than inventing the missing history.
  const selected = parts.filter((part, index) =>
    "entryId" in part && part.entryId ? branch.has(part.entryId) : end >= 0 && index <= end,
  );
  applySnapshot(preview, {
    parts: messageSnapshots(selected, preview.sessionId),
    model: source.model ? { id: source.model.id } : undefined,
    thinkingLevel: source.thinkingLevel,
    availableThinkingLevels: [...source.availableThinkingLevels],
  });
}
