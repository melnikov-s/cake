/** Minimal shape of a session summary needed to determine sidebar list order. */
interface OrderableSessionSummary {
  modifiedAt: string;
  draft?: boolean;
}

/** Saved drafts are pinned first; sessions within each lane follow latest activity. */
export function compareSessionSummariesForSidebar(
  left: OrderableSessionSummary,
  right: OrderableSessionSummary,
): number {
  if (Boolean(left.draft) !== Boolean(right.draft)) return left.draft ? -1 : 1;
  return right.modifiedAt.localeCompare(left.modifiedAt);
}
