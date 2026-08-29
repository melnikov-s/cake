import { useState } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import { IconButton } from "./ui/icon-button";
import { PullRequestIcon, ResolveIcon, RestoreIcon } from "./ui/icons";
import type { SidebarStore } from "../stores/SidebarStore";

export interface SidebarSessionItemProps {
  store: SidebarStore;
  session: {
    id: string;
    title: string;
    modified: string;
    managedWorktree?: {
      branch: string;
      baseBranch: string;
      parentWorktreePath?: string;
    };
  };
  selected: boolean;
  resolved: boolean;
  activity?: "running" | "unread";
  defaultBranch?: string;
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
  defaultBranch,
  onOpen,
  onRename,
  onResolve,
}: SidebarSessionItemProps) {
  const [renamingValue, setRenamingValue] = useState<string | null>(null);
  const running = activity === "running";
  const unread = activity === "unread";
  const canResolve = !running && !unread;
  const activityLabel = running ? "Running" : "Ready, unread";
  const branch = session.managedWorktree?.branch.replace(/^agent\//, "") ?? defaultBranch;
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
        "session-item group relative flex min-h-11 w-full items-center rounded-md py-1 text-xs select-none transition-colors",
        selected
          ? "active bg-sidebar-active text-primary font-semibold shadow-[inset_3px_0_0_var(--primary)]"
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
            className="session-row flex min-w-0 flex-1 flex-col items-start justify-center self-stretch bg-transparent py-1 pl-2 pr-1 text-left text-inherit"
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
            <span className="session-title w-full min-w-0 truncate text-left" title={session.title}>
              {session.title}
            </span>
            {branch && (
              <span
                className={cn(
                  "mt-1.5 flex max-w-full items-center gap-1.5 text-[10px] font-normal leading-none",
                  selected ? "text-primary/80" : "text-muted-foreground/80",
                )}
              >
                <PullRequestIcon />
                <span className="truncate">{branch}</span>
                {session.managedWorktree && (
                  <>
                    <span aria-hidden="true">→</span>
                    <span className="truncate">
                      {session.managedWorktree.baseBranch.replace(/^agent\//, "")}
                    </span>
                  </>
                )}
              </span>
            )}
          </button>
          <div className="session-meta relative flex h-full w-14 shrink-0 items-center justify-center">
            {activity ? (
              <i
                className={cn(
                  "session-status size-2 rounded-full shrink-0",
                  activity === "running" &&
                    cn(
                      "session-status-running animate-pulse",
                      selected ? "bg-primary" : "bg-accent",
                    ),
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
                      "session-resolve-action size-6 flex items-center justify-center rounded transition-opacity",
                      selected
                        ? "text-primary/80 opacity-100 hover:bg-primary/10 hover:text-primary"
                        : "absolute inset-0 m-auto text-muted-foreground opacity-0 hover:bg-sidebar-hover hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
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
