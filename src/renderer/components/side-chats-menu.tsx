import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Button } from "./ui/button";
import { ChatIcon, PlusIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverNumberedIconTrigger } from "./ui/popover";
import { SessionActivityIndicator } from "./session-activity-indicator";

/**
 * Only unresolved side chats belong in the menu; workers stay in Activity. A
 * conversation that can start side chats always shows the trigger, even at zero.
 */
export const SideChatsMenu = observer(function SideChatsMenu({
  store,
  onOpen,
}: {
  store: {
    readonly sessionId: string;
    openSideChat?(threadId: string): boolean;
    /** The conversation's own side-chat start, as used by `/sidechat`; empty opens a draft. */
    createSideChat?(prompt: string): Promise<boolean>;
  };
  /** Reveals/focuses the owning chat surface in companion and detached hosts. */
  onOpen?(): void;
}) {
  const navigator = useStore(RootStore).conversationNavigatorStore;
  const [open, setOpen] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const entries = navigator
    .ownedConversations(store.sessionId)
    .filter((entry) => entry.target.kind === "side-chat");
  const createSideChat = store.createSideChat?.bind(store);
  if (entries.length === 0 && !createSideChat) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) setCreateError(undefined);
      }}
    >
      <PopoverNumberedIconTrigger
        count={entries.length}
        data-cake-hint-key="c"
        tooltip={entries.length ? `Side chats, ${entries.length} open` : "Side chats"}
        onClick={onOpen}
      >
        <ChatIcon size={18} />
      </PopoverNumberedIconTrigger>
      <PopoverContent
        align="end"
        boundary="nearest-ancestor"
        className="flex w-[min(22rem,calc(100vw-24px))] flex-col overflow-hidden p-0"
        aria-label="Open side chats"
      >
        <section aria-label="Side chats" className="min-h-0 max-h-96 overflow-y-auto">
          <div className="flex items-center justify-between gap-2 border-b border-border/65 bg-sidebar/30 px-3 py-2">
            <h2 className="text-xs font-semibold text-foreground">Side chats</h2>
            {entries.length > 0 && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {entries.length}
              </span>
            )}
          </div>
          {entries.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No side chats yet.
            </p>
          ) : (
            <div className="grid gap-0.5 p-1.5">
              {entries.map((entry) => (
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
                    <ChatIcon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-xs font-medium text-foreground"
                      title={entry.title}
                    >
                      {entry.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                      {entry.running ? "Working…" : (entry.preview ?? "Waiting for a reply")}
                    </span>
                  </span>
                  <SessionActivityIndicator activity={entry.activity} />
                </Button>
              ))}
            </div>
          )}
        </section>
        {(createError ?? navigator.error) && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {createError ?? navigator.error}
          </p>
        )}
        {createSideChat && (
          <div className="border-t border-border/65 p-1.5">
            <Button
              className="w-full justify-start gap-2.5 px-2.5"
              variant="ghost"
              size="sm"
              disabled={creating}
              onClick={async () => {
                setCreating(true);
                setCreateError(undefined);
                onOpen?.();
                try {
                  if (await createSideChat("")) setOpen(false);
                  else setCreateError("Send a message before starting a side chat");
                } catch (error) {
                  setCreateError(error instanceof Error ? error.message : String(error));
                } finally {
                  setCreating(false);
                }
              }}
            >
              <PlusIcon size={14} />
              New side chat
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
