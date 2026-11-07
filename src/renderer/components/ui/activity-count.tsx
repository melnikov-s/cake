import { cn } from "@/lib/utils";
import { ActivityIcon } from "./icons";

/** Compact running-work count; exact values remain accessible beyond the visual cap. */
export function ActivityCount({ count }: { count: number }) {
  return (
    <span
      role="img"
      aria-label={`${count} running`}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
        count > 0 ? "text-accent" : "text-muted-foreground",
      )}
    >
      <ActivityIcon />
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
    </span>
  );
}
