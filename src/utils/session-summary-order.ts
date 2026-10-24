/** Minimal shape of a session summary needed to determine sidebar list order. */
interface OrderableSessionSummary {
  modifiedAt: string;
  draft?: boolean;
  working?: boolean;
}

/** Working sessions lead; idle drafts remain pinned within the non-working lane. */
export function compareSessionSummariesForSidebar(
  left: OrderableSessionSummary,
  right: OrderableSessionSummary,
): number {
  if (Boolean(left.working) !== Boolean(right.working)) return left.working ? -1 : 1;
  if (Boolean(left.draft) !== Boolean(right.draft)) return left.draft ? -1 : 1;
  return compareSessionSummariesByActivity(left, right);
}

/** Pure latest-activity order (newest first) used by the Activity feed; drafts are not pinned. */
export function compareSessionSummariesByActivity(
  left: Pick<OrderableSessionSummary, "modifiedAt">,
  right: Pick<OrderableSessionSummary, "modifiedAt">,
): number {
  return right.modifiedAt.localeCompare(left.modifiedAt);
}
