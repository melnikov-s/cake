import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { GlobalSessionSummary } from "../../ipc/session-contract";
import { ContextMenu } from "./ui/context-menu";
import { IconButton } from "./ui/icon-button";
import { ResolveIcon, RestoreIcon } from "./ui/icons";
import type { AppShellStore } from "../stores/AppShellStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SidebarStore } from "../stores/SidebarStore";

export interface SidebarSessionItemProps {
  store: SidebarStore;
  chat: ProjectWorkbenchStore;
  shell: AppShellStore;
  session: GlobalSessionSummary;
  resolved: boolean;
  onOpen(sessionId: string): void;
}

/** One project session row in the sidebar; owns its own rename draft and context menu. */
export const SidebarSessionItem = observer(function SidebarSessionItem({
  store,
  chat,
  shell,
  session,
  resolved,
  onOpen,
}: SidebarSessionItemProps) {
  const [renamingValue, setRenamingValue] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const selected =
    shell.selection.kind === "project-session" && shell.selection.sessionId === session.id;
  const activity = store.sessionActivity(session.id);
  const running = activity === "running";
  const unread = activity === "unread";
  const canResolve = !running && !unread;
  const activityLabel = running ? "Running" : "Ready, unread";
  const commitRename = () => {
    const value = renamingValue;
    setRenamingValue(null);
    if (!value) return;
    const name = value.trim();
    if (!name) return;
    void chat.renameSession(session.id, name);
  };
  return (
    <div
      data-session-id={session.id}
      className={`session-item ${selected && canResolve ? "has-session-action" : ""} ${selected ? "active" : ""}`}
    >
      {renamingValue !== null ? (
        <input
          className="session-rename-input"
          aria-label="Session name"
          value={renamingValue}
          autoFocus
          onChange={(event) => setRenamingValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            else if (event.key === "Escape") setRenamingValue(null);
          }}
        />
      ) : (
        <button
          className="session-row"
          aria-current={selected ? "page" : undefined}
          onClick={() => onOpen(session.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <span className="session-title" title={session.title}>
            {session.title}
          </span>
          <span className="session-meta">
            <span className="session-time-slot">
              {!selected && !running && !unread ? (
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
              {activity && (
                <i
                  className={`session-status session-status-${activity}`}
                  role="img"
                  aria-label={activityLabel}
                  title={activityLabel}
                />
              )}
            </span>
          </span>
        </button>
      )}
      {canResolve && renamingValue === null && (
        <IconButton
          className="session-resolve-action"
          tooltip={resolved ? "Restore" : "Resolve"}
          ariaLabel={`${resolved ? "Restore" : "Resolve"} ${session.title}`}
          onClick={(event) => {
            event.stopPropagation();
            void store.setSessionResolved(session.id, !resolved);
          }}
        >
          {resolved ? <RestoreIcon /> : <ResolveIcon />}
        </IconButton>
      )}
      {menu && (
        <ContextMenu
          position={menu}
          onClose={() => setMenu(null)}
          items={[
            {
              id: "rename",
              label: "Rename",
              onSelect: () => setRenamingValue(session.title),
            },
            {
              id: "copy-session-id",
              label: "Copy Session ID",
              onSelect: () => {
                void navigator.clipboard.writeText(session.id);
              },
            },
          ]}
        />
      )}
    </div>
  );
});
