import { cn } from "@/lib/utils";
import { ActivityIcon } from "./icons";
import { StatusDot } from "./status-dot";

/** Compact own-status count; exact values remain accessible beyond the visual cap. */
export function ActivityCount({
  count,
  kind = "running",
}: {
  count: number;
  kind?: "running" | "unread";
}) {
  if (kind === "unread" && count === 0) return null;
  const label = `${count} ${kind}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
        kind === "unread" ? "text-success" : count > 0 ? "text-accent" : "text-muted-foreground",
      )}
    >
      {kind === "unread" ? <StatusDot status="success" size="sm" /> : <ActivityIcon />}
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
    </span>
  );
}
