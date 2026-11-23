import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { ChatStore } from "../stores/ChatStore";
import { Button } from "./ui/button";
import {
  ChatIcon,
  DiffIcon,
  LogIcon,
  MoreIcon,
  PlusIcon,
  SparkleIcon,
  WorkLogCollapsedIcon,
  WorkLogFullyExpandedIcon,
  WorkLogSemiExpandedIcon,
} from "./ui/icons";
import { Popover, PopoverContent, PopoverNumberedIconTrigger } from "./ui/popover";
import { SegmentedControlButton, SegmentedControlGroup } from "./ui/segmented-control";
import { SessionActivityIndicator } from "./session-activity-indicator";

/** Consolidated secondary conversation controls: side chats and work log display options. */
export const SessionMoreMenu = observer(function SessionMoreMenu({
  session,
  chatStore,
  onOpenSideChat,
}: {
  session: {
    readonly sessionId: string;
    openSideChat?(threadId: string): boolean;
    createSideChat?(prompt: string): Promise<boolean>;
  };
  chatStore: ChatStore;
  onOpenSideChat?(): void;
}) {
  const navigator = useStore(RootStore).conversationNavigatorStore;
  const [open, setOpen] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const entries = navigator
    .ownedConversations(session.sessionId)
    .filter((entry) => entry.target.kind === "side-chat");
  const createSideChat = session.createSideChat?.bind(session);
  const showSideChats = entries.length > 0 || Boolean(createSideChat);
  const viewMode = chatStore.workLogPresentation.viewMode;
  const expansion = chatStore.workLogPresentation.expansion;

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
        countPlacement="inline"
        data-cake-hint-key="w"
        tooltip={
          entries.length
            ? `Conversation options (${entries.length} side ${entries.length === 1 ? "chat" : "chats"})`
            : "Conversation options"
        }
      >
        <MoreIcon />
      </PopoverNumberedIconTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        offset={6}
        boundary="nearest-ancestor"
        aria-label="Conversation options"
        className="flex w-[min(21rem,calc(100vw-24px))] flex-col overflow-hidden p-0 shadow-lg"
      >
        {showSideChats && (
          <section aria-label="Side chats" className="min-h-0 max-h-64 overflow-y-auto">
            <div className="flex items-center justify-between gap-2 border-b border-border/65 bg-sidebar/30 px-3 py-2">
              <h2 className="text-xs font-semibold text-foreground">Side chats</h2>
              {entries.length > 0 && (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {entries.length}
                </span>
              )}
            </div>
            {entries.length > 0 && (
              <div className="grid gap-0.5 p-1.5">
                {entries.map((entry) => (
                  <Button
                    key={entry.key}
                    className="h-auto min-w-0 justify-start gap-2.5 rounded-md px-2.5 py-2 text-left"
                    variant="ghost"
                    aria-label={entry.title}
                    onClick={async () => {
                      onOpenSideChat?.();
                      if (entry.target.kind === "side-chat" && session.openSideChat) {
                        if (session.openSideChat(entry.target.threadId)) setOpen(false);
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
            {(createError ?? navigator.error) && (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                {createError ?? navigator.error}
              </p>
            )}
            {createSideChat && (
              <div className="p-1.5">
                <Button
                  className="w-full justify-start gap-2 px-2.5"
                  variant="ghost"
                  size="sm"
                  disabled={creating}
                  onClick={async () => {
                    setCreating(true);
                    setCreateError(undefined);
                    onOpenSideChat?.();
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
          </section>
        )}

        <div className={showSideChats ? "border-t border-border/65 p-2.5" : "p-2.5"}>
          <section className="grid gap-1.5" aria-labelledby="more-work-log-view-mode-title">
            <header
              id="more-work-log-view-mode-title"
              className="text-xs font-medium text-muted-foreground"
            >
              Work log view
            </header>
            <SegmentedControlGroup
              size="sm"
              className="grid w-full grid-cols-3"
              aria-label="Work log view mode"
            >
              <SegmentedControlButton
                size="sm"
                className="transition-colors"
                active={viewMode === "auto"}
                aria-label="Auto view mode"
                onClick={() => chatStore.workLogPresentation.setViewMode("auto")}
              >
                <SparkleIcon />
                <span className="ml-1">Auto</span>
              </SegmentedControlButton>
              <SegmentedControlButton
                size="sm"
                className="transition-colors"
                active={viewMode === "diff"}
                aria-label="Diff view mode"
                onClick={() => chatStore.workLogPresentation.setViewMode("diff")}
              >
                <DiffIcon />
                <span className="ml-1">Diff</span>
              </SegmentedControlButton>
              <SegmentedControlButton
                size="sm"
                className="transition-colors"
                active={viewMode === "log"}
                aria-label="Log view mode"
                onClick={() => chatStore.workLogPresentation.setViewMode("log")}
              >
                <LogIcon />
                <span className="ml-1">Log</span>
              </SegmentedControlButton>
            </SegmentedControlGroup>
          </section>

          <div className="my-2 border-t border-border/70" />

          <section className="grid gap-1.5" aria-labelledby="more-work-log-expansion-title">
            <header
              id="more-work-log-expansion-title"
              className="text-xs font-medium text-muted-foreground"
            >
              Work log detail
            </header>
            <SegmentedControlGroup
              size="sm"
              className="grid w-full grid-cols-3"
              aria-label="Work log expansion"
            >
              <SegmentedControlButton
                size="sm"
                className="transition-colors"
                active={expansion === "collapsed"}
                aria-label="Collapsed work logs"
                onClick={() => chatStore.workLogPresentation.setExpansion("collapsed")}
              >
                <WorkLogCollapsedIcon />
                <span className="ml-1">Collapsed</span>
              </SegmentedControlButton>
              <SegmentedControlButton
                size="sm"
                className="transition-colors"
                active={expansion === "expanded"}
                aria-label="Compact work logs"
                onClick={() => chatStore.workLogPresentation.setExpansion("expanded")}
              >
                <WorkLogSemiExpandedIcon />
                <span className="ml-1">Compact</span>
              </SegmentedControlButton>
              <SegmentedControlButton
                size="sm"
                className="transition-colors"
                active={expansion === "fully-expanded"}
                aria-label="Full work logs"
                onClick={() => chatStore.workLogPresentation.setExpansion("fully-expanded")}
              >
                <WorkLogFullyExpandedIcon />
                <span className="ml-1">Full</span>
              </SegmentedControlButton>
            </SegmentedControlGroup>
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
});
