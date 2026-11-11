import type { SessionPurpose } from "../contracts/project-sessions/session-purpose";

export function compareSessionPurposes(
  left: { purpose?: SessionPurpose },
  right: { purpose?: SessionPurpose },
): number {
  return Number(left.purpose === "delegated") - Number(right.purpose === "delegated");
}

/** User Sessions first, then stable newest-created-first order; activity and catalog arrival order never move rows. */
export function compareSessionSummariesByCreation(
  left: { createdAt: string; sessionId: string; purpose?: SessionPurpose },
  right: { createdAt: string; sessionId: string; purpose?: SessionPurpose },
): number {
  return (
    compareSessionPurposes(left, right) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.sessionId.localeCompare(right.sessionId)
  );
}

/** Minimal shape of a session summary needed to determine sidebar list order. */
interface OrderableSessionSummary {
  purpose?: SessionPurpose;
  modifiedAt: string;
  draft?: boolean;
  working?: boolean;
}

/** Working sessions lead; idle drafts remain pinned within the non-working lane. */
export function compareSessionSummariesForSidebar(
  left: OrderableSessionSummary,
  right: OrderableSessionSummary,
): number {
  const purposeOrder = compareSessionPurposes(left, right);
  if (purposeOrder) return purposeOrder;
  if (Boolean(left.working) !== Boolean(right.working)) return left.working ? -1 : 1;
  if (Boolean(left.draft) !== Boolean(right.draft)) return left.draft ? -1 : 1;
  return compareSessionSummariesByActivity(left, right);
}

/** Latest-activity order (newest first) for recency-based catalogs and resolved history. */
function compareSessionSummariesByActivity(
  left: Pick<OrderableSessionSummary, "modifiedAt">,
  right: Pick<OrderableSessionSummary, "modifiedAt">,
): number {
  return right.modifiedAt.localeCompare(left.modifiedAt);
}
