/* Adapted from Vercel AI Elements message.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Cake-owned props only. */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import type { MessageActionAlign } from "@/lib/message-action-placement";
import { MessageActions } from "./message-actions";

export function Message({
  className,
  children,
  actions,
  actionsAlign,
  fullscreen,
  ...props
}: ComponentProps<"article"> & {
  actions?: ReactNode;
  /** Follows the message's own alignment; right-aligned messages keep actions on the right. */
  actionsAlign?: MessageActionAlign;
  /** Joins the action group; the floating toolbar keeps it reachable from anywhere in the message. */
  fullscreen?: { label: string; onClick(): void };
}) {
  return (
    <article
      data-slot="message"
      className={cn("group group/msg relative grid min-w-0 max-w-full gap-2", className)}
      {...props}
    >
      {children}
      {(actions || fullscreen) && (
        <MessageActions align={actionsAlign}>
          {actions}
          {fullscreen && <FullscreenButton {...fullscreen} />}
        </MessageActions>
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
        "min-w-0 max-w-full overflow-hidden rounded-[14px] border border-hairline bg-card px-5 py-4 text-[0.94rem] leading-7 shadow-[inset_0_1px_0_var(--surface-rim),var(--card-shadow)] [contain:paint]",
        className,
      )}
      {...props}
    />
  );
}
