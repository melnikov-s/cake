/* Adapted from Vercel AI Elements message.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Cake-owned props only. */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { MessageActions } from "./message-actions";

export function Message({
  className,
  children,
  actions,
  fullscreen,
  ...props
}: ComponentProps<"article"> & {
  actions?: ReactNode;
  fullscreen?: { label: string; onClick(): void };
}) {
  return (
    <article
      data-slot="message"
      className={cn("group group/msg relative grid min-w-0 max-w-full gap-2", className)}
      {...props}
    >
      {children}
      {actions && <MessageActions>{actions}</MessageActions>}
      {fullscreen && (
        <FullscreenButton
          className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md bg-transparent p-0 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/msg:opacity-100 group-focus-within/msg:opacity-100"
          {...fullscreen}
        />
      )}
    </article>
  );
}

export function MessageLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-label"
      className={cn("text-xs font-medium text-muted-foreground", className)}
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
