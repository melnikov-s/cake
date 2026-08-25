import { observer } from "r-state-tree/react";
import type { GlobalChatStore } from "../stores/GlobalChatStore";
import type { AppShellStore } from "../stores/AppShellStore";
import type { SidebarStore } from "../stores/SidebarStore";
import { cn } from "../lib/utils";
import { CakeIcon, ChevronIcon, PlusIcon, ResolveIcon, RestoreIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";

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
            const canResolve = !running;
            return (
              <div
                key={session.id}
                data-session-id={session.id}
                className={cn(
                  "session-item group relative flex h-7.5 w-full items-center rounded-md text-xs select-none transition-colors",
                  selected
                    ? "active bg-sidebar-active text-foreground font-semibold shadow-[inset_3px_0_0_var(--accent)]"
                    : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
                  canResolve && "can-resolve",
                  selected && canResolve && "has-session-action",
                )}
              >
                <div className="flex h-full w-full min-w-0 items-center justify-between">
                  <button
                    type="button"
                    className="session-row flex min-w-0 flex-1 items-center h-full pl-2 pr-1 text-left bg-transparent border-0 cursor-pointer text-inherit"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onOpenCakeChat(session.id)}
                  >
                    <span
                      className="session-title min-w-0 flex-1 truncate text-left"
                      title={session.title}
                    >
                      {session.title}
                    </span>
                  </button>
                  <div className="session-meta relative w-14 shrink-0 flex items-center justify-center h-full">
                    {running ? (
                      <i
                        className="session-status session-status-running size-2 rounded-full shrink-0 bg-accent animate-pulse"
                        role="img"
                        aria-label="Running"
                        title="Running"
                      />
                    ) : (
                      <>
                        {!selected && (
                          <time
                            className={cn(
                              "session-time text-[10px] text-muted-foreground tabular-nums text-center whitespace-nowrap transition-opacity",
                              canResolve && "session-time-replaceable group-hover:opacity-0",
                            )}
                            dateTime={session.modified}
                            title={new Date(session.modified).toLocaleString()}
                          >
                            {store.sessionActivityTime(session.modified)}
                          </time>
                        )}
                        {canResolve && (
                          <IconButton
                            className={cn(
                              "session-resolve-action size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover transition-opacity",
                              selected
                                ? "opacity-100"
                                : "absolute inset-0 m-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                            )}
                            tooltip={resolved ? "Restore" : "Resolve"}
                            ariaLabel={`${resolved ? "Restore" : "Resolve"} ${session.title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void store.setCakeChatSessionResolved(session.id, !resolved);
                            }}
                          >
                            {resolved ? <RestoreIcon /> : <ResolveIcon />}
                          </IconButton>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
