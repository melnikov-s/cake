import { cn } from "@/lib/utils";
import { StatusDot } from "./status-dot";
import { CountBadge } from "./count-badge";

/** Compact own-status count; exact values remain accessible beyond the visual cap. */
export function ActivityCount({
  count,
  kind = "running",
  compact = false,
}: {
  count: number;
  kind?: "running" | "unread";
  /** A colored badge beside an icon-only tab; zero counts are left to the tab's label. */
  compact?: boolean;
}) {
  if (count === 0) return null;
  const label = `${count} ${kind}`;
  if (compact)
    return (
      <CountBadge
        count={count}
        tone={kind === "unread" ? "success" : "accent"}
        role="img"
        aria-label={label}
        title={label}
      />
    );
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs tabular-nums",
        kind === "unread" ? "text-success" : "text-accent",
      )}
    >
      <StatusDot status={kind === "unread" ? "success" : "running"} size="sm" />
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
    </span>
  );
}
