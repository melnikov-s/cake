import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Button } from "./ui/button";
import { BotIcon, ChatIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverNumberedIconTrigger } from "./ui/popover";
import { SessionActivityIndicator } from "./session-activity-indicator";

/** The conversation's side chats and private workers share its existing speech-bubble menu. */
export const SideChatsMenu = observer(function SideChatsMenu({
  store,
  onOpen,
}: {
  store: {
    readonly sessionId: string;
    openSideChat?(threadId: string): boolean;
  };
  /** Reveals/focuses the owning chat surface in companion and detached hosts. */
  onOpen?(): void;
}) {
  const navigator = useStore(RootStore).conversationNavigatorStore;
  const [open, setOpen] = useState(false);
  const entries = navigator.ownedConversations(store.sessionId);
  if (entries.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverNumberedIconTrigger
        count={entries.length}
        data-cake-hint-key="c"
        tooltip={
          entries.some((entry) => entry.target.kind === "subagent")
            ? `Side chats and subagents, ${entries.length}`
            : `Side chats, ${entries.length} open`
        }
        onClick={onOpen}
      >
        <ChatIcon size={14} />
      </PopoverNumberedIconTrigger>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-24px))] overflow-hidden p-0"
        aria-label="Open side chats"
      >
        <div className="max-h-96 overflow-y-auto">
          {(["side-chat", "subagent"] as const).map((kind) => {
            const section = entries.filter((entry) => entry.target.kind === kind);
            const title = kind === "side-chat" ? "Side chats" : "Subagents";
            return (
              <section key={kind} aria-label={title}>
                <div className="flex items-center justify-between gap-2 border-b border-border/65 bg-sidebar/30 px-3 py-2">
                  <h2 className="text-xs font-semibold text-foreground">{title}</h2>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {section.length}
                  </span>
                </div>
                {section.length ? (
                  <div className="grid gap-0.5 p-1.5">
                    {section.map((entry) => (
                      <Button
                        key={entry.key}
                        className="h-auto min-w-0 justify-start gap-2.5 rounded-md px-2.5 py-2 text-left"
                        variant="ghost"
                        aria-label={entry.title}
                        onClick={async () => {
                          onOpen?.();
                          if (entry.target.kind === "side-chat" && store.openSideChat) {
                            if (store.openSideChat(entry.target.threadId)) setOpen(false);
                          } else {
                            await navigator.open(entry);
                            if (!navigator.error) setOpen(false);
                          }
                        }}
                      >
                        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                          {kind === "subagent" ? <BotIcon size={14} /> : <ChatIcon size={14} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-xs font-medium text-foreground"
                            title={entry.title}
                          >
                            {entry.title}
                          </span>
                          <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                            {entry.running
                              ? "Working…"
                              : (entry.preview ??
                                (kind === "side-chat" ? "Waiting for a reply" : "Subagent"))}
                          </span>
                        </span>
                        <SessionActivityIndicator activity={entry.activity} />
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="px-3 py-3 text-xs text-muted-foreground">
                    {kind === "side-chat" ? "No open side chats" : "No subagents"}
                  </p>
                )}
              </section>
            );
          })}
        </div>
        {navigator.error && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {navigator.error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
});
