import { useState } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import { IconButton } from "./ui/icon-button";
import { ResolveIcon, RestoreIcon } from "./ui/icons";
import type { SidebarStore } from "../stores/SidebarStore";

export interface SidebarSessionItemProps {
  store: SidebarStore;
  session: { id: string; title: string; modified: string };
  selected: boolean;
  resolved: boolean;
  activity?: "running" | "unread";
  onOpen(sessionId: string): void;
  onRename(sessionId: string, name: string): void;
  onResolve(sessionId: string, resolved: boolean): void;
}

/** One session row in the sidebar; owns its own rename draft. */
export const SidebarSessionItem = observer(function SidebarSessionItem({
  store,
  session,
  selected,
  resolved,
  activity,
  onOpen,
  onRename,
  onResolve,
}: SidebarSessionItemProps) {
  const [renamingValue, setRenamingValue] = useState<string | null>(null);
  const running = activity === "running";
  const unread = activity === "unread";
  const canResolve = !running && !unread;
  const activityLabel = running ? "Running" : "Ready, unread";
  const commitRename = () => {
    const value = renamingValue;
    setRenamingValue(null);
    if (!value) return;
    const name = value.trim();
    if (name) onRename(session.id, name);
  };
  return (
    <div
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
      {renamingValue !== null ? (
        <input
          className="session-rename-input w-full h-7 rounded-md border border-accent/50 bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-accent"
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
        <div className="flex h-full w-full min-w-0 items-center justify-between">
          <button
            type="button"
            className="session-row flex min-w-0 flex-1 items-center h-full pl-2 pr-1 text-left bg-transparent border-0 cursor-pointer text-inherit"
            aria-current={selected ? "page" : undefined}
            onClick={() => onOpen(session.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              void store
                .showSessionContextMenu(session.id, event.clientX, event.clientY)
                .then((action) => {
                  if (action === "rename") setRenamingValue(session.title);
                });
            }}
          >
            <span className="session-title min-w-0 flex-1 truncate text-left" title={session.title}>
              {session.title}
            </span>
          </button>
          <div className="session-meta relative w-14 shrink-0 flex items-center justify-center h-full">
            {activity ? (
              <i
                className={cn(
                  "session-status size-2 rounded-full shrink-0",
                  activity === "running" && "session-status-running bg-accent animate-pulse",
                  activity === "unread" &&
                    "session-status-unread bg-emerald-500 ring-2 ring-emerald-500/20",
                )}
                role="img"
                aria-label={activityLabel}
                title={activityLabel}
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
                      onResolve(session.id, !resolved);
                    }}
                  >
                    {resolved ? <RestoreIcon /> : <ResolveIcon />}
                  </IconButton>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
