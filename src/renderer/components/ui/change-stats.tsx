import { cn } from "@/lib/utils";

/** Compact Git line deltas; binary counts never masquerade as zero-line changes. */
export function ChangeStats({
  additions,
  deletions,
  binary = 0,
  className,
}: {
  additions: number | null;
  deletions: number | null;
  binary?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-mono text-xs font-normal tabular-nums",
        className,
      )}
    >
      {additions === null || deletions === null ? (
        <span className="text-muted-foreground">Binary</span>
      ) : (
        <>
          <span className="text-success">+{additions}</span>
          <span className="text-destructive">−{deletions}</span>
          {binary > 0 && <span className="text-muted-foreground">{binary} binary</span>}
        </>
      )}
    </span>
  );
}
