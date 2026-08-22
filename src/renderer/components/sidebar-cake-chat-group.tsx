import { observer } from "r-state-tree/react";
import type { GlobalChatStore } from "../stores/GlobalChatStore";
import type { AppShellStore } from "../stores/AppShellStore";
import type { SidebarStore } from "../stores/SidebarStore";
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
    <div className={`project-group cake-chat-sessions ${empty ? "project-group-empty" : ""}`}>
      <div className="project-row" title="Cake Chat">
        <IconButton
          className={`project-disclosure ${collapsed ? "collapsed" : ""} ${empty ? "no-sessions" : ""}`}
          aria-expanded={!collapsed}
          tooltip={collapsed ? "Expand" : "Collapse"}
          ariaLabel={`${collapsed ? "Expand" : "Collapse"} Cake Chat${resolved ? " resolved" : ""}`}
          onClick={() => store.toggleGroupCollapsed(collapseKey)}
        >
          <ChevronIcon />
        </IconButton>
        <button
          className="project-label"
          type="button"
          aria-label={
            collapsed ? `Expand Cake Chat${resolved ? " resolved" : ""}` : "Open Cake Chat"
          }
          onClick={() => (resolved ? store.toggleGroupCollapsed(collapseKey) : onOpenCakeChat())}
        >
          <CakeIcon />
          <span>Cake Chat</span>
        </button>
        {!resolved && (
          <IconButton className="project-add" tooltip="New Cake Chat" onClick={onCreateCakeChat}>
            <PlusIcon />
          </IconButton>
        )}
      </div>
      {!collapsed &&
        sessions.map((session) => {
          const selected =
            shell.selection.kind === "cake-chat" && shell.selection.sessionId === session.id;
          const running = cakeChat.findSession(session.id)?.streaming === true;
          const canResolve = !running;
          return (
            <div
              key={session.id}
              data-session-id={session.id}
              className={`session-item ${selected && canResolve ? "has-session-action" : ""} ${selected ? "active" : ""}`}
            >
              <button
                className="session-row"
                aria-current={selected ? "page" : undefined}
                onClick={() => onOpenCakeChat(session.id)}
              >
                <span className="session-title" title={session.title}>
                  {session.title}
                </span>
                <span className="session-meta">
                  <span className="session-time-slot">
                    {!selected && !running ? (
                      <time
                        className={`session-time ${canResolve ? "session-time-replaceable" : ""}`}
                        dateTime={session.modified}
                        title={new Date(session.modified).toLocaleString()}
                      >
                        {store.sessionActivityTime(session.modified)}
                      </time>
                    ) : null}
                  </span>
                  <span className="session-status-slot">
                    {running && (
                      <i
                        className="session-status session-status-running"
                        role="img"
                        aria-label="Running"
                        title="Running"
                      />
                    )}
                  </span>
                </span>
              </button>
              {canResolve && (
                <IconButton
                  className="session-resolve-action"
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
            </div>
          );
        })}
    </div>
  );
});
