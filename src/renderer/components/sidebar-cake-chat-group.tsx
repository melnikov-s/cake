import { observer } from "r-state-tree/react";
import type { GlobalChatStore } from "../stores/GlobalChatStore";
import type { AppShellStore } from "../stores/AppShellStore";
import type { SidebarStore } from "../stores/SidebarStore";
import { cn } from "../lib/utils";
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
  if (resolved && sessions.length === 0) return null;
  const collapseKey = `${resolved ? "resolved" : "active"}:cake-chat`;
  const collapsed = store.isGroupCollapsed(collapseKey);
  const empty = sessions.length === 0;
  return (
    <div
      className={cn(
        "project-group cake-chat-sessions mb-3 last:mb-0",
        empty && "project-group-empty mb-1",
      )}
    >
      <div
        className="project-row group/proj flex h-8 w-full items-center gap-1 px-1 select-none text-muted-foreground"
        title="Cake Chat"
      >
        <IconButton
          className={cn(
            "project-disclosure size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-transform duration-150",
            collapsed && "collapsed -rotate-90",
            empty && "no-sessions invisible",
          )}
          aria-expanded={!collapsed}
          tooltip={collapsed ? "Expand" : "Collapse"}
          ariaLabel={`${collapsed ? "Expand" : "Collapse"} Cake Chat${resolved ? " resolved" : ""}`}
          onClick={() => store.toggleGroupCollapsed(collapseKey)}
        >
          <ChevronIcon />
        </IconButton>
        <button
          className="project-label flex min-w-0 flex-1 items-center gap-2 h-7 px-1 rounded text-left text-xs font-medium text-inherit hover:text-foreground"
          type="button"
          aria-label={
            collapsed ? `Expand Cake Chat${resolved ? " resolved" : ""}` : "New Cake Chat"
          }
          onClick={() => (resolved ? store.toggleGroupCollapsed(collapseKey) : onCreateCakeChat())}
        >
          <CakeIcon />
          <span className="truncate">Cake Chat</span>
        </button>
        {!resolved && (
          <IconButton
            className="project-add size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity"
            tooltip="New Cake Chat"
            onClick={onCreateCakeChat}
          >
            <PlusIcon />
          </IconButton>
        )}
      </div>
      {!collapsed && (
        <div className="flex flex-col pl-5 space-y-0.5 mt-0.5">
          {sessions.map((session) => {
            const selected =
              shell.selection.kind === "cake-chat" && shell.selection.sessionId === session.id;
            const running = cakeChat.findSession(session.id)?.streaming === true;
            return (
              <SidebarSessionItem
                key={session.id}
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
              />
            );
          })}
        </div>
      )}
    </div>
  );
});
