import { forwardRef, useLayoutEffect, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Let virtual padding and the rendered rows determine the native scroll extent. */
export const TranscriptScroller = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { context?: { onLayout?: () => void } }
>(function TranscriptScroller({ context, className, ...props }, ref) {
  useLayoutEffect(() => context?.onLayout?.());
  // With customScrollParent, Virtuoso otherwise fixes this wrapper to its last
  // measured total and absolutely positions the list. That leaves stale native
  // geometry until its next measurement. Normal flow keeps row/footer resizes
  // visible to scroll reconciliation without synchronous virtualizer writes
  // inside ResizeObserver delivery (which resize already-delivered ancestors).
  return (
    <div
      ref={ref}
      className={cn("h-auto! [&>[data-viewport-type=window]]:relative!", className)}
      {...props}
    />
  );
});
