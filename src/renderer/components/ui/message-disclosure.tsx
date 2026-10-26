import { useId, type ReactNode } from "react";
import { DisclosureTrigger } from "./disclosure-trigger";

/**
 * One disclosure layout for incoming messages, batch notes and original-source readers.
 * The open body is never height-capped: the transcript is the only scroller, so a long
 * message reads like any assistant reply and collapsing is the way to shorten it.
 */
export function MessageDisclosure({
  title,
  open,
  onToggle,
  children,
  triggerSlot = "response-disclosure",
  ariaLabel,
}: {
  title: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
  triggerSlot?: string;
  ariaLabel?: string;
}) {
  const contentId = useId();
  return (
    <div className="min-w-0 py-1" data-slot="message-disclosure">
      <DisclosureTrigger
        data-slot={triggerSlot}
        title={title}
        aria-label={ariaLabel}
        wrapTitle
        chevronPosition="start"
        className="rounded-md px-2 py-2 text-sm leading-relaxed outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
        open={open}
        aria-controls={open ? contentId : undefined}
        onClick={onToggle}
      />
      {open && (
        <div
          id={contentId}
          className="flex min-w-0 flex-col gap-3 border-t border-border/60 px-2 pt-3 pb-2"
        >
          {children}
        </div>
      )}
    </div>
  );
}
