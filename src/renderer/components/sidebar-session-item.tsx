import { useState } from "react";
import { observer } from "r-state-tree/react";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import type { ProjectWorkflowColor } from "../../domain/application/application-data";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { IconButton } from "./ui/icon-button";
import { Input } from "./ui/input";
import { NavItem } from "./ui/nav-item";
import { ChevronIcon, ResolveIcon, RestoreIcon } from "./ui/icons";
import type { SidebarStore } from "../stores/SidebarStore";
import { WorktreeStatusIcon } from "./worktree-status-icon";
import type { SessionActivity } from "../lib/session-activity";
import { StatusDot } from "./ui/status-dot";
import { StatusSwatch } from "./ui/status-swatch";
import { Avatar } from "./ui/avatar";

export interface SidebarSessionItemProps {
  store: SidebarStore;
  session: {
    sessionId: string;
    title: string;
    modifiedAt: string;
    workingDirectory?: string;
    draft?: boolean;
    worktreeName?: string;
    familyParentSessionId?: string;
    familyChildSessionIds?: readonly string[];
  };
  managedWorktree?: Pick<WorktreeRecord, "branch" | "baseBranch" | "parentWorktreePath" | "state">;
  selected: boolean;
  paneNumber?: number;
  resolved: boolean;
  activity?: SessionActivity;
  workflowStatus?: { name: string; color: ProjectWorkflowColor };
  avatarSeed: string;
  avatarsEnabled: boolean;
  focusMode?: boolean;
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
  managedWorktree,
  selected,
  paneNumber,
  resolved,
  activity,
  workflowStatus,
  avatarSeed,
  avatarsEnabled,
  focusMode = false,
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
  const canResolve = !activity && !isFamilyChild;
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
    : (session.worktreeName ?? managedWorktree?.branch.replace(/^agent\//, ""));
  const baseBranch = managedWorktree?.baseBranch.replace(/^agent\//, "");
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
      data-animated-list-key={session.sessionId}
      data-session-id={session.sessionId}
      data-family-role={isFamilyChild ? "child" : isFamilyParent ? "parent" : "root"}
      className={cn(
        "session-item group relative grid min-h-11 w-full items-center rounded-md py-1 text-[13px] select-none transition-colors",
        focusMode && "min-h-14 text-sm [&_[data-slot=avatar]]:size-7 [&_svg]:size-5",
        avatarsEnabled
          ? isFamilyParent
            ? focusMode
              ? "grid-cols-[3rem_minmax(0,1fr)]"
              : "grid-cols-[2.5rem_minmax(0,1fr)]"
            : focusMode
              ? "grid-cols-[2rem_minmax(0,1fr)]"
              : "grid-cols-[1.5rem_minmax(0,1fr)]"
          : "grid-cols-[1.25rem_minmax(0,1fr)]",
        isFamilyChild && "ml-5 w-[calc(100%-1.25rem)]",
        selected
          ? "active bg-sidebar-active text-primary font-semibold"
          : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
        canResolve && "can-resolve",
        selected && canResolve && "has-session-action",
      )}
    >
      {renamingValue === null && (
        <div
          data-slot="session-leading"
          className="relative flex h-full items-center justify-center"
        >
          {isFamilyParent && (
            <IconButton
              className={cn(
                "size-5 shrink-0 text-muted-foreground transition-transform",
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
          {avatarsEnabled ? (
            <Avatar
              kind="session"
              seed={avatarSeed}
              statusColor={workflowStatus?.color}
              title={workflowStatus?.name ?? "No workflow status"}
              role="img"
              aria-label={workflowStatus ? `Status: ${workflowStatus.name}` : "No workflow status"}
            />
          ) : (
            workflowStatus && (
              <StatusSwatch
                color={workflowStatus.color}
                className={isFamilyParent ? "absolute -left-2" : undefined}
                title={workflowStatus.name}
                role="img"
                aria-label={`Status: ${workflowStatus.name}`}
              />
            )
          )}
        </div>
      )}
      {renamingValue !== null ? (
        <Input
          size="sm"
          className="session-rename-input col-start-2 mr-2 w-[calc(100%-0.5rem)]"
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
          className={cn(
            "session-row col-start-2 bg-transparent hover:bg-transparent",
            focusMode && "py-2 text-sm",
          )}
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
            <span
              data-slot="session-description"
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 text-[11px] font-normal leading-none",
                focusMode && "text-xs leading-tight",
                selected ? "text-primary/80" : "text-muted-foreground/80",
              )}
            >
              {branch && !isFamilyChild && (
                <>
                  {managedWorktree && (
                    <WorktreeStatusIcon state={managedWorktree.state} className="shrink-0" />
                  )}
                  <span className="truncate">{branch}</span>
                  {showBaseBranch && (
                    <>
                      <span aria-hidden="true">→</span>
                      <span className="truncate">{baseBranch}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                </>
              )}
              <time
                className={cn(
                  "session-time shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground",
                  focusMode && "text-xs",
                )}
                dateTime={session.modifiedAt}
                title={new Date(session.modifiedAt).toLocaleString()}
              >
                {store.sessionActivityTime(session.modifiedAt)}
              </time>
            </span>
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
