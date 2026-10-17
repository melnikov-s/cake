import { forwardRef, useLayoutEffect, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const TranscriptList = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { context?: { onLayout?: () => void } }
>(function TranscriptList({ className, context, ...props }, ref) {
  // A measured row can resize the virtualizer's shallower container. Its
  // ResizeObserver notification may be deferred by the browser's depth limit;
  // reconcile this commit in a layout effect instead of painting that gap.
  useLayoutEffect(() => context?.onLayout?.());
  return (
    <div
      ref={ref}
      className={cn(
        "mx-auto w-full max-w-[51rem] min-w-0 px-6 pt-[42px] max-[620px]:px-4 in-[.chat-layout-compact]:px-3 in-[.chat-layout-compact]:pt-5",
        className,
      )}
      aria-label="Conversation"
      {...props}
    />
  );
});
