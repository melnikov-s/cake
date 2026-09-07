import { useState } from "react";
import { observer } from "r-state-tree/react";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import type { ProjectWorkflowColor } from "../../domain/application-data";
import type { WorktreeRecord } from "../../ipc/worktree-contract";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { IconButton } from "./ui/icon-button";
import { NavItem } from "./ui/nav-item";
import { ChevronIcon, ResolveIcon, RestoreIcon } from "./ui/icons";
import type { SidebarStore } from "../stores/SidebarStore";
import { WorktreeStatusIcon } from "./worktree-status-icon";
import type { SessionActivity } from "../session-activity";
import { StatusDot } from "./ui/status-dot";
import { StatusSwatch } from "./ui/status-swatch";

export interface SidebarSessionItemProps {
  store: SidebarStore;
  session: {
    sessionId: string;
    title: string;
    modifiedAt: string;
    draft?: boolean;
    worktreeName?: string;
    managedWorktree?: Pick<
      WorktreeRecord,
      "branch" | "baseBranch" | "parentWorktreePath" | "state"
    >;
    familyParentSessionId?: string;
    familyChildSessionIds?: readonly string[];
  };
  selected: boolean;
  paneNumber?: number;
  resolved: boolean;
  activity?: SessionActivity;
  workflowStatus?: { name: string; color: ProjectWorkflowColor };
  onOpen(sessionId: string): void;
  onToggleFamily?(sessionId: string): void;
  familyCollapsed?: boolean;
  onRename(sessionId: string, name: string): void;
  onResolve(sessionId: string, resolved: boolean): void;
  onSetStatus?(sessionId: string, statusId: string): void;
  onDelete(sessionId: string): void;
  /** Omitted on surfaces without unread support; enables the context-menu toggle. */
  onMarkUnread?(sessionId: string, unread: boolean): void;
}

/** One session row in the sidebar; owns its own rename draft. */
export const SidebarSessionItem = observer(function SidebarSessionItem({
  store,
  session,
  selected,
  paneNumber,
  resolved,
  activity,
  workflowStatus,
  onOpen,
  onToggleFamily,
  familyCollapsed,
  onRename,
  onResolve,
  onSetStatus,
  onDelete,
  onMarkUnread,
}: SidebarSessionItemProps) {
  const [renamingValue, setRenamingValue] = useState<string | null>(null);
  const unread = activity === "unread";
  const isFamilyParent = Boolean(session.familyChildSessionIds?.length);
  const isFamilyChild =
    Boolean(session.familyParentSessionId) && session.familyParentSessionId !== session.sessionId;
  const canResolve = !activity && !isFamilyChild && !session.draft;
  const activityLabel =
    activity === "waiting"
      ? "Waiting for your answer"
      : activity === "running"
        ? "Running"
        : activity === "error"
          ? "Error"
          : "Ready, unread";
  const branch = session.draft
    ? undefined
    : (session.worktreeName ?? session.managedWorktree?.branch.replace(/^agent\//, ""));
  const baseBranch = session.managedWorktree?.baseBranch.replace(/^agent\//, "");
  const showBaseBranch = baseBranch !== undefined && baseBranch !== "main";
  const commitRename = () => {
    const value = renamingValue;
    setRenamingValue(null);
    if (!value) return;
    const name = value.trim();
    if (name) onRename(session.sessionId, name);
  };
  return (
    <div
      data-session-id={session.sessionId}
      className={cn(
        "session-item group relative flex min-h-11 w-full items-center rounded-md py-1 text-xs select-none transition-colors",
        isFamilyChild &&
          "ml-3 w-[calc(100%-0.75rem)] pl-3 before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border after:absolute after:left-0 after:top-1/2 after:h-px after:w-2 after:bg-border",
        selected
          ? "active bg-sidebar-active text-primary font-semibold"
          : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
        canResolve && "can-resolve",
        selected && canResolve && "has-session-action",
      )}
    >
      {isFamilyParent && renamingValue === null && (
        <IconButton
          className={cn(
            "ml-0.5 size-5 shrink-0 text-muted-foreground transition-transform",
            familyCollapsed && "-rotate-90",
          )}
          tooltip={familyCollapsed ? "Expand child sessions" : "Collapse child sessions"}
          ariaLabel={`${familyCollapsed ? "Expand" : "Collapse"} children of ${session.title}`}
          aria-expanded={!familyCollapsed}
          onClick={() => onToggleFamily?.(session.sessionId)}
        >
          <ChevronIcon />
        </IconButton>
      )}
      {workflowStatus && renamingValue === null && (
        <StatusSwatch
          color={workflowStatus.color}
          className="absolute top-3 -left-4"
          title={workflowStatus.name}
          role="img"
          aria-label={`Status: ${workflowStatus.name}`}
        />
      )}
      {renamingValue !== null ? (
        <input
          className="session-rename-input w-full h-7 rounded-md border border-accent/50 bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-accent"
          aria-label="Session name"
          value={renamingValue}
          maxLength={SESSION_TITLE_MAX_LENGTH}
          autoFocus
          onChange={(event) => setRenamingValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitRename();
            else if (event.key === "Escape") setRenamingValue(null);
          }}
        />
      ) : (
        <NavItem
          className="session-row flex-1"
          active={selected}
          onClick={() => onOpen(session.sessionId)}
          onContextMenu={(event) => {
            event.preventDefault();
            const { clientX, clientY } = event;
            requestAnimationFrame(() => {
              const menu = isFamilyChild
                ? store.showSessionContextMenu(
                    session.sessionId,
                    clientX,
                    clientY,
                    resolved,
                    onMarkUnread ? unread : undefined,
                    true,
                  )
                : store.showSessionContextMenu(
                    session.sessionId,
                    clientX,
                    clientY,
                    resolved,
                    onMarkUnread ? unread : undefined,
                  );
              void menu.then((action) => {
                if (action?.action === "rename") setRenamingValue(session.title);
                else if (action?.action === "mark-unread") onMarkUnread?.(session.sessionId, true);
                else if (action?.action === "resolve" && !isFamilyChild)
                  onResolve(session.sessionId, true);
                else if (action?.action === "unresolve" && !isFamilyChild)
                  onResolve(session.sessionId, false);
                else if (action?.action === "set-status")
                  onSetStatus?.(session.sessionId, action.statusId);
                else if (action?.action === "delete" && !isFamilyChild) onDelete(session.sessionId);
              });
            });
          }}
          label={<span className="session-title min-w-0 truncate">{session.title}</span>}
          badge={
            (session.draft || paneNumber !== undefined) && (
              <span className="flex items-center gap-1">
                {session.draft && (
                  <Badge variant="outline" size="xs" className="text-muted-foreground">
                    Draft
                  </Badge>
                )}
                {paneNumber !== undefined && (
                  <Badge variant={selected ? "default" : "outline"} size="xs">
                    {paneNumber}
                  </Badge>
                )}
              </span>
            )
          }
          description={
            (branch || !activity) && (
              <span
                className={cn(
                  "flex w-full min-w-0 items-center gap-1.5 text-[10px] font-normal leading-none",
                  selected ? "text-primary/80" : "text-muted-foreground/80",
                )}
              >
                {branch && (
                  <>
                    {session.managedWorktree && (
                      <WorktreeStatusIcon
                        state={session.managedWorktree.state}
                        className="shrink-0"
                      />
                    )}
                    <span className="truncate">{branch}</span>
                    {showBaseBranch && (
                      <>
                        <span aria-hidden="true">→</span>
                        <span className="truncate">{baseBranch}</span>
                      </>
                    )}
                  </>
                )}
                {!activity && (
                  <>
                    {branch && <span aria-hidden="true">·</span>}
                    <time
                      className="session-time shrink-0 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground"
                      dateTime={session.modifiedAt}
                      title={new Date(session.modifiedAt).toLocaleString()}
                    >
                      {store.sessionActivityTime(session.modifiedAt)}
                    </time>
                  </>
                )}
              </span>
            )
          }
          trailing={
            <div className="session-meta relative flex h-full w-8 shrink-0 items-center justify-center">
              {activity ? (
                <StatusDot
                  status={
                    activity === "waiting"
                      ? "attention"
                      : activity === "unread"
                        ? "success"
                        : activity
                  }
                  className={cn(
                    "session-status size-2",
                    activity === "waiting" && "session-status-waiting ring-2 ring-attention/20",
                    activity === "running" &&
                      cn("session-status-running", selected && "bg-primary"),
                    activity === "unread" && "session-status-unread ring-2 ring-success/20",
                    activity === "error" && "session-status-error ring-2 ring-destructive/20",
                  )}
                  role="img"
                  aria-hidden={undefined}
                  aria-label={activityLabel}
                  title={activityLabel}
                />
              ) : (
                canResolve && (
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
                      onResolve(session.sessionId, !resolved);
                    }}
                  >
                    {resolved ? <RestoreIcon /> : <ResolveIcon />}
                  </IconButton>
                )
              )}
            </div>
          }
        />
      )}
    </div>
  );
});
