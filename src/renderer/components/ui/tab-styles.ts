import { cn } from "@/lib/utils";

/** Shared Cake-owned tab chrome; navigation and segmented choices keep their own treatment. */
export function tabSurfaceClassName(selected: boolean) {
  return cn(
    "relative rounded-lg border transition-colors",
    selected
      ? "border-accent/35 bg-accent/15 text-accent hover:bg-accent/20"
      : "border-transparent bg-transparent text-muted-foreground hover:bg-foreground/[0.055] hover:text-foreground",
  );
}

// Inset focus stays visible inside a horizontally scrolling strip and is distinct from selection.
export const tabFocusClassName =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:ring-offset-0";
