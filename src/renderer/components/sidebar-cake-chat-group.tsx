import { observer } from "r-state-tree/react";
import type { GlobalChatStore } from "../stores/GlobalChatStore";
import type { AppShellStore } from "../stores/AppShellStore";
import type { SidebarStore } from "../stores/SidebarStore";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { CakeIcon, ChevronIcon, PlusIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { SidebarSessionItem } from "./sidebar-session-item";

export interface SidebarCakeChatGroupProps {
  store: SidebarStore;
  cakeChat: GlobalChatStore;
  shell: AppShellStore;
  resolved: boolean;
  onOpenCakeChat(sessionId?: string): void;
  onCreateCakeChat(): void;
}

/** The Cake Chat section in the sidebar: header row plus its session rows. */
export const SidebarCakeChatGroup = observer(function SidebarCakeChatGroup({
  store,
  cakeChat,
  shell,
  resolved,
  onOpenCakeChat,
  onCreateCakeChat,
}: SidebarCakeChatGroupProps) {
  const sessions = store.cakeChatSessions(resolved);
  const visibleSessions = sessions.slice(0, store.sessionLimit("cake-chat", resolved));
  const expanded = resolved
    ? store.isResolvedGroupExpanded("cake-chat")
    : store.isActiveGroupExpanded("cake-chat");
  const empty = sessions.length === 0;
  return (
    <div data-slot="cake-chat-group" className={cn("mb-3 last:mb-0", empty && "mb-1")}>
      <div
        className="group/proj flex h-8 w-full items-center gap-1 px-1 select-none text-muted-foreground"
        title="Cake Chat"
      >
        <IconButton
          className={cn(
            "size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-transform duration-150",
            !expanded && "-rotate-90",
          )}
          aria-expanded={expanded}
          tooltip={expanded ? "Collapse" : "Expand"}
          ariaLabel={`${expanded ? "Collapse" : "Expand"} Cake Chat${resolved ? " resolved" : ""}`}
          onClick={() =>
            resolved
              ? store.toggleResolvedGroupExpanded("cake-chat")
              : store.toggleActiveGroupExpanded("cake-chat")
          }
        >
          <ChevronIcon />
        </IconButton>
        <Button
          data-slot="project-label"
          variant="ghost"
          className="h-7 min-w-0 flex-1 justify-start gap-2 px-1 text-xs font-medium text-inherit hover:text-foreground"
          type="button"
          aria-label={
            resolved ? `${expanded ? "Collapse" : "Expand"} Cake Chat resolved` : "New Cake Chat"
          }
          onClick={() =>
            resolved ? store.toggleResolvedGroupExpanded("cake-chat") : onCreateCakeChat()
          }
        >
          <CakeIcon />
          <span className="truncate">Cake Chat</span>
        </Button>
        {!resolved && (
          <IconButton
            className="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity"
            tooltip="New Cake Chat"
            onClick={onCreateCakeChat}
          >
            <PlusIcon />
          </IconButton>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col pl-5 space-y-0.5 mt-0.5">
          {visibleSessions.map((session) => {
            const selected =
              shell.selection.kind === "cake-chat" &&
              shell.selection.sessionId === session.sessionId;
            const running = cakeChat.findSession(session.sessionId)?.streaming === true;
            return (
              <SidebarSessionItem
                key={session.sessionId}
                store={store}
                session={session}
                selected={selected}
                resolved={resolved}
                activity={running ? "running" : undefined}
                onOpen={onOpenCakeChat}
                onRename={(sessionId, name) => void cakeChat.renameSession(sessionId, name)}
                onResolve={(sessionId, nextResolved) =>
                  void store.setCakeChatSessionResolved(sessionId, nextResolved)
                }
                onDelete={(sessionId) => void store.deleteCakeChatSession(sessionId)}
              />
            );
          })}
          {sessions.length > visibleSessions.length && (
            <Button
              variant="ghost"
              className="h-7 justify-start px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => store.showMoreSessions("cake-chat", resolved)}
            >
              Show more
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
