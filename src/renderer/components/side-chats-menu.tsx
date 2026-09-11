import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ReviewThread } from "../models/ReviewThread";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ChatIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { StatusDot } from "./ui/status-dot";

function threadTitle(thread: ReviewThread) {
  if (thread.anchor.selectedText) return thread.anchor.selectedText;
  return thread.textParts.find((part) => part.role === "user")?.text ?? "Side chat";
}

function threadPreview(thread: ReviewThread) {
  return (
    thread.textParts.findLast((part) => part.role === "assistant")?.text ?? "Waiting for a reply"
  );
}

/** Session-scoped access to every open user side chat. */
export const SideChatsMenu = observer(function SideChatsMenu({
  store,
  onOpen,
}: {
  store: ProjectSessionStore;
  onOpen(): void;
}) {
  const [open, setOpen] = useState(false);
  const threads = store.sideChatThreads;

  if (threads.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        className="relative"
        tooltip={`Side chats, ${threads.length} open`}
        onClick={onOpen}
      >
        <ChatIcon size={14} />
        <Badge
          className="absolute -right-1 -top-1 min-w-4 justify-center px-1"
          size="xs"
          variant="mono"
        >
          {threads.length}
        </Badge>
      </PopoverIconTrigger>
      <PopoverContent
        align="end"
        className="w-[min(24rem,calc(100vw-24px))] p-2"
        aria-label="Open side chats"
      >
        <div className="mb-1 flex items-center gap-2 px-2 py-1">
          <ChatIcon size={14} />
          <strong className="font-mono text-[10px] uppercase tracking-wider">
            Open side chats
          </strong>
        </div>
        {threads.length ? (
          <div className="grid gap-1">
            {threads.map((thread) => (
              <Button
                key={thread.id}
                className="h-auto min-w-0 justify-start gap-2 px-2.5 py-2 text-left"
                variant="ghost"
                onClick={() => {
                  onOpen();
                  if (store.openSideChat(thread.id)) setOpen(false);
                }}
              >
                <StatusDot status={thread.streaming ? "running" : "complete"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{threadTitle(thread)}</span>
                  <span className="block truncate text-[10px] font-normal text-muted-foreground">
                    {thread.streaming ? "Working…" : threadPreview(thread)}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">No open side chats</p>
        )}
      </PopoverContent>
    </Popover>
  );
});
