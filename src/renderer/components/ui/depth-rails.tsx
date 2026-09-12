import { cn } from "../../lib/utils";

export interface DepthRailsProps {
  depth: number;
  className?: string;
}

/** Compact hierarchy marker that keeps neighboring row content aligned. */
export function DepthRails({ depth, className }: DepthRailsProps) {
  if (depth <= 0) return null;
  return (
    <span
      data-slot="depth-rails"
      data-depth={depth}
      className={cn(
        "flex h-full min-w-2 max-w-4 flex-1 items-stretch justify-end gap-0.5 overflow-hidden",
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} className="h-full min-w-px max-w-1 flex-1 border-l border-border/70" />
      ))}
    </span>
  );
}
