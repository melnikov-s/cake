/** Minimal shape of a session summary needed to determine sidebar list order. */
interface OrderableSessionSummary {
  messageCount: number;
  modifiedAt: string;
}

/**
 * Sidebar list order for session summaries: sessions with no submitted
 * messages ("New chat") are always pinned to the top, newest first; every
 * other session follows by latest activity.
 */
export function compareSessionSummariesForSidebar(
  left: OrderableSessionSummary,
  right: OrderableSessionSummary,
): number {
  const leftUnsubmitted = left.messageCount === 0;
  const rightUnsubmitted = right.messageCount === 0;
  if (leftUnsubmitted !== rightUnsubmitted) return leftUnsubmitted ? -1 : 1;
  return right.modifiedAt.localeCompare(left.modifiedAt);
}
