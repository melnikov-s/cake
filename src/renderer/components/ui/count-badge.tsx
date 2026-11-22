import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const tones = {
  neutral: "bg-foreground/[0.08] text-muted-foreground",
  accent: "bg-accent/15 text-accent",
  success: "bg-success/15 text-success",
} as const;

/** A small count pill beside an icon; the visual value caps at 99+. */
export function CountBadge({
  count,
  tone = "neutral",
  className,
  ...props
}: { count: number; tone?: keyof typeof tones } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-xs leading-none font-semibold tabular-nums",
        tones[tone],
        className,
      )}
    >
      <span aria-hidden={props["aria-label"] ? true : undefined}>{count > 99 ? "99+" : count}</span>
    </span>
  );
}
