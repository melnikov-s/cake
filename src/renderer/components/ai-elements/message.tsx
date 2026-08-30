/* Adapted from Vercel AI Elements message.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Cake-owned props only. */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Message({ className, ...props }: ComponentProps<"article">) {
  return (
    <article
      data-slot="message"
      className={cn("group grid min-w-0 max-w-full gap-2", className)}
      {...props}
    />
  );
}

export function MessageLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-label"
      className={cn(
        "font-mono text-[0.64rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "min-w-0 max-w-full overflow-hidden rounded-2xl border border-border bg-card px-5 py-4 text-[0.94rem] leading-7 shadow-[0_12px_35px_-30px_rgba(18,22,27,0.45)] [contain:paint]",
        className,
      )}
      {...props}
    />
  );
}
