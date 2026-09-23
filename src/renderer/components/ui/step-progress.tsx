import { cn } from "@/lib/utils";

/** Segmented progress for a multi-step flow. Each segment is a jump target
 *  when `onSelect` is supplied; `completed` marks segments with a value. */
export function StepProgress({
  count,
  current,
  completed,
  label,
  stepLabel,
  onSelect,
  className,
}: {
  count: number;
  current: number;
  completed?: (index: number) => boolean;
  label: string;
  stepLabel?: (index: number) => string;
  onSelect?: (index: number) => void;
  className?: string;
}) {
  return (
    <ol aria-label={label} className={cn("flex items-center gap-1", className)}>
      {Array.from({ length: count }, (_, index) => {
        const segment = cn(
          "block h-1.5 w-full rounded-full transition-colors",
          index === current
            ? "bg-primary"
            : completed?.(index)
              ? "bg-primary/45"
              : "bg-muted-foreground/25",
        );
        const name = stepLabel?.(index) ?? `Step ${index + 1}`;
        return (
          <li key={index} className="min-w-0 flex-1">
            {onSelect ? (
              <button
                type="button"
                aria-label={name}
                aria-current={index === current ? "step" : undefined}
                className="flex w-full items-center rounded-full py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(index)}
              >
                <span className={segment} />
              </button>
            ) : (
              <span
                aria-label={name}
                aria-current={index === current ? "step" : undefined}
                className={cn(segment, "my-1")}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
