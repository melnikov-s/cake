/** Minimal shape of a session summary needed to determine sidebar list order. */
interface OrderableSessionSummary {
  messageCount: number;
  modifiedAt: string;
  draft?: boolean;
}

/**
 * Sidebar list order for session summaries: saved drafts are always pinned
 * above other sessions. Unsubmitted sessions ("New chat") follow, then every
 * other session by latest activity. Each pinned group is newest first.
 */
export function compareSessionSummariesForSidebar(
  left: OrderableSessionSummary,
  right: OrderableSessionSummary,
): number {
  if (Boolean(left.draft) !== Boolean(right.draft)) return left.draft ? -1 : 1;
  const leftUnsubmitted = left.messageCount === 0;
  const rightUnsubmitted = right.messageCount === 0;
  if (leftUnsubmitted !== rightUnsubmitted) return leftUnsubmitted ? -1 : 1;
  return right.modifiedAt.localeCompare(left.modifiedAt);
}
