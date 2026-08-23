import { forwardRef, type ComponentProps } from "react";

export const TranscriptList = forwardRef<HTMLDivElement, ComponentProps<"div">>(
  function TranscriptList({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`transcript-list ${className ?? ""}`}
        aria-label="Conversation"
        {...props}
      />
    );
  },
);
