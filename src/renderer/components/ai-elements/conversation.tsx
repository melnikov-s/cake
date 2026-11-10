/*
 * Inspired by Vercel AI Elements conversation.tsx at
 * 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0).
 * Modified by Cake to remove AI SDK contracts.
 */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Conversation({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-5 overflow-x-hidden",
        className,
      )}
      aria-label="Conversation"
      {...props}
    />
  );
}
