import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../contracts/conversations/session-contract";
import { AttachmentTile } from "./ui/attachment-tile";
import { PaperclipIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverNumberedIconTrigger } from "./ui/popover";

/** Read-only queue payload preview; never pulls the message back into the composer. */
export function QueuedAttachmentIndicator({ attachments }: { attachments: readonly Attachment[] }) {
  const [mode, setMode] = useState<"hover" | "active" | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const enter = () => {
    cancelClose();
    setMode((current) => current ?? "hover");
  };
  const leave = () => {
    cancelClose();
    // Allow the pointer to cross the gap between the trigger and its portal.
    closeTimer.current = setTimeout(() => {
      setMode((current) => (current === "hover" ? null : current));
    }, 150);
  };
  if (!attachments.length) return null;
  const label = `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;
  return (
    <Popover open={mode !== null} onOpenChange={(open) => setMode(open ? "active" : null)}>
      <PopoverNumberedIconTrigger
        count={attachments.length}
        ariaLabel={`View ${label}`}
        className="h-7"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onClick={(event) => {
          if (mode !== "hover") return;
          // A click pins a hover preview; keyboard/touch activation opens normally.
          event.preventDefault();
          setMode("active");
        }}
      >
        <PaperclipIcon />
      </PopoverNumberedIconTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label={`Queued message ${label}`}
        data-cake-private-preview="true"
        className="max-h-[min(24rem,60dvh)] w-fit max-w-[min(28rem,calc(100vw-1rem))]"
        onMouseEnter={cancelClose}
        onMouseLeave={leave}
      >
        <div className="mb-2 text-xs font-medium text-muted-foreground">{label}</div>
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <AttachmentTile
              key={`${attachment.kind}-${index}`}
              name={
                attachment.kind === "annotation"
                  ? `${attachment.annotations.length} annotation${attachment.annotations.length === 1 ? "" : "s"}`
                  : attachment.name
              }
              imageSrc={
                attachment.kind === "image"
                  ? `data:${attachment.mimeType};base64,${attachment.data}`
                  : undefined
              }
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
