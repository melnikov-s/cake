import { forwardRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const TranscriptList = forwardRef<
  HTMLDivElement,
  ComponentProps<"div"> & { context?: unknown }
>(function TranscriptList({ className, context, ...props }, ref) {
  // Virtuoso's render context is not a DOM attribute.
  void context;
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
