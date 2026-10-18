import type { ContextInspectionNode } from "../../contracts/conversations/context-inspection";

/**
 * Estimate the explorer's current outline text, not provider usage. Pi's estimateTokens
 * uses the same chars/4 heuristic, but accepts runtime messages and is not renderer-safe.
 * Count summary titles (their payload) instead of their historical children. Other
 * titles, source paths and lazy memory-detail results are UI/provenance, not context.
 * Serialized content is counted as displayed text, not model-specific image/tool costs.
 */
export function estimateContextTokens(sources: readonly ContextInspectionNode[]): number {
  function characters(nodes: readonly ContextInspectionNode[]): number {
    return nodes.reduce(
      (total, node) =>
        total +
        (node.kind === "summary"
          ? node.title.length
          : (node.text?.length ?? 0) + characters(node.children ?? [])),
      0,
    );
  }
  return Math.ceil(characters(sources) / 4);
}

const compactCount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatEstimatedContextTokens(tokens: number): string {
  return `≈${compactCount.format(tokens).toLowerCase()} ${tokens === 1 ? "token" : "tokens"}`;
}
