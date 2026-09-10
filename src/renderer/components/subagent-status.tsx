import { useRef, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";
import type { ChatStore } from "../stores/ChatStore";
import { cn } from "@/lib/utils";
import { ChatPopover } from "./message-comment-popover";
import { Button } from "./ui/button";
import { ChatIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { StatusDot } from "./ui/status-dot";

/** Persistent access to every active private worker owned by this conversation. */
export const SubagentStatus = observer(function SubagentStatus({
  store,
  renderChat,
}: {
  store: SubagentActivityStore;
  renderChat(store: ChatStore): ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [listOpen, setListOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string>();
  const activeRuns = store.activeRuns;
  const selectedRun = selectedKey ? store.run(selectedKey) : undefined;
  const selectedChat = selectedRun ? store.chatStore(selectedRun.key) : undefined;
  const count = activeRuns.length;

  return (
    <div
      ref={anchorRef}
      className={cn("pointer-events-auto flex min-w-0 justify-end", count > 0 && "mb-1.5")}
    >
      {count > 0 && (
        <Popover open={listOpen} onOpenChange={setListOpen}>
          <PopoverTrigger
            className="h-7 gap-2 rounded-full bg-card/95 px-2.5 font-mono text-[10px] shadow-sm"
            size="sm"
            variant="outline"
            aria-label={`${count} subagents running`}
          >
            <StatusDot status="running" />
            {count} subagents running
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-[min(24rem,calc(100vw-24px))] p-2"
            side="top"
            aria-label="Active subagents"
          >
            <div className="mb-1 flex items-center gap-2 px-2 py-1">
              <ChatIcon size={14} />
              <strong className="font-mono text-[10px] uppercase tracking-wider">
                Active subagents
              </strong>
            </div>
            <div className="grid gap-1">
              {activeRuns.map((run) => (
                <Button
                  key={run.key}
                  className="h-auto min-w-0 justify-start gap-2 px-2.5 py-2 text-left"
                  variant="ghost"
                  onClick={() => {
                    setSelectedKey(run.key);
                    setListOpen(false);
                  }}
                >
                  <StatusDot status={run.status === "running" ? "running" : "pending"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{run.task}</span>
                    <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">
                      Subagent · {run.status}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}

      {selectedRun && selectedChat && anchorRef.current && (
        <ChatPopover
          anchor={anchorRef.current}
          title="Subagent"
          eyebrow={selectedRun.released ? "Released" : selectedRun.status}
          onClose={() => setSelectedKey(undefined)}
        >
          {renderChat(selectedChat)}
        </ChatPopover>
      )}
    </div>
  );
});
