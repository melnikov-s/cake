import { cn } from "@/lib/utils";

/** Shared Cake-owned tab chrome; navigation and segmented choices keep their own treatment. */
export function tabSurfaceClassName(selected: boolean) {
  return cn(
    "relative rounded-sm border transition-colors",
    selected
      ? "border-accent/60 bg-card text-foreground shadow-2xs after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent hover:bg-card"
      : "border-border bg-muted/40 text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted/80 hover:text-foreground",
  );
}

// Inset focus stays visible inside a horizontally scrolling strip and is distinct from selection.
export const tabFocusClassName =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:ring-offset-0";
