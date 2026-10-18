import { convertToLlm, estimateTokens, type SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { SessionContextMetadata } from "../../../contracts/conversations/session-context-metadata";
import { modelActivityMetadata } from "../../../utils/session-context-cost";
import { toolCompactProvenanceEntryType } from "./tool-compaction-provenance";

export function projectSessionContextMetadata(manager: SessionManager): SessionContextMetadata {
  const projection = manager.buildSessionProjection();
  const system = getCurrentSystemMessage(projection.messages);
  // Use the current projection's contents, never stale pre-compaction usage or
  // display parts (which deliberately include originals behind summaries).
  const estimatedTokens = convertToLlm(
    projection.messages.filter((message) => message.role !== "system"),
  ).reduce((sum, message) => sum + estimateTokens(message), system ? estimateTokens(system) : 0);
  const branch = manager.getBranch();
  const invalidated = branch.findLastIndex(
    (entry) =>
      entry.type === "compaction" ||
      entry.type === "context_edit" ||
      entry.type === "branch_summary" ||
      entry.type === "model_change" ||
      (entry.type === "custom" && entry.customType === toolCompactProvenanceEntryType),
  );
  const lastAssistant = branch.findLastIndex(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  const activity = modelActivityMetadata(projection.messages);
  const { cacheObservation } = activity;
  const { lastModelActivityAt } = modelActivityMetadata(
    branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
  );
  return {
    estimatedTokens,
    ...(lastModelActivityAt ? { lastModelActivityAt } : null),
    ...(invalidated <= lastAssistant && cacheObservation ? { cacheObservation } : null),
  };
}
