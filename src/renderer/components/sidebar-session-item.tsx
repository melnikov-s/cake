import { useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import type { ProjectIcon, SessionLabel } from "../../domain/application/application-data";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { IconButton } from "./ui/icon-button";
import { Input } from "./ui/input";
import { NavItem } from "./ui/nav-item";
import { CakeIcon, ChevronIcon, ResolveIcon, RestoreIcon } from "./ui/icons";
import type { SidebarStore } from "../stores/SidebarStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import { WorktreeStatusIcon } from "./worktree-status-icon";
import type { SessionActivity } from "../lib/session-activity";
import { StatusDot } from "./ui/status-dot";
import { LabelSwatch } from "./ui/label-swatch";
import { Avatar } from "./ui/avatar";
import { AvatarLabelPicker } from "./ui/avatar-label-picker";
import { DepthRails } from "./ui/depth-rails";

export interface SidebarSessionItemProps {
  store: SidebarStore;
  sessionMetadata?: SessionMetadataStore;
  session: {
    sessionId: string;
    title: string;
    modifiedAt: string;
    workingDirectory?: string;
    draft?: boolean;
    worktreeName?: string;
    familyParentSessionId?: string;
    familyChildSessionIds?: readonly string[];
    familyDepth?: number;
  };
  managedWorktree?: Pick<WorktreeRecord, "branch" | "baseBranch" | "parentWorktreePath" | "state">;
  selected: boolean;
  paneNumber?: number;
  resolved: boolean;
  activity?: SessionActivity;
  labels: readonly SessionLabel[];
  avatarSeed: string;
  avatarsEnabled: boolean;
  source?:
    | {
        kind: "project";
        name: string;
        avatarSeed: string;
        customIcon?: ProjectIcon;
        showAvatar: boolean;
      }
    | { kind: "cake-chat"; name: string };
  focusMode?: boolean;
  onOpen(sessionId: string): void;
  onToggleFamily?(sessionId: string): void;
  familyCollapsed?: boolean;
  onRename(sessionId: string, name: string): void;
  onResolve(sessionId: string, resolved: boolean): void;
  onSetLabels?(sessionId: string, labelIds: readonly string[]): void;
  onDelete(sessionId: string): void;
  /** Omitted on surfaces without unread support; enables the context-menu toggle. */
  onMarkUnread?(sessionId: string, unread: boolean): void;
}

/** One session row in the sidebar; owns its own rename draft. */
export const SidebarSessionItem = observer(function SidebarSessionItem({
  store,
  sessionMetadata,
  session,
  managedWorktree,
  selected,
  paneNumber,
  resolved,
  activity,
  labels,
  avatarSeed,
  avatarsEnabled,
  source,
  focusMode = false,
  onOpen,
  onToggleFamily,
  familyCollapsed,
  onRename,
  onResolve,
  onSetLabels,
  onDelete,
  onMarkUnread,
}: SidebarSessionItemProps) {
  const [renamingValue, setRenamingValue] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const avatarInteraction = { target: rowRef, activationTarget: navigationRef };
  const unread = activity === "unread";
  const isFamilyParent = Boolean(session.familyChildSessionIds?.length);
  const isFamilyChild =
    Boolean(session.familyParentSessionId) && session.familyParentSessionId !== session.sessionId;
  const canResolve = !activity && !isFamilyChild;
  const labelIds = sessionMetadata?.sessionLabelIds(session.sessionId) ?? [];
  const availableLabels = sessionMetadata?.availableSessionLabels(session.sessionId) ?? [];
  const canSetLabels = !session.draft && !resolved && Boolean(onSetLabels);
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
      ref={rowRef}
      data-animated-list-key={session.sessionId}
      data-session-id={session.sessionId}
      data-navigation-item=""
      data-navigation-active={selected}
      data-family-role={isFamilyChild ? "child" : isFamilyParent ? "parent" : "root"}
      className={cn(
        "session-item group relative grid min-h-11 w-full items-center rounded-md text-[13px] select-none transition-colors duration-200 ease-out motion-reduce:transition-none",
        focusMode && "min-h-14 text-sm [&_[data-slot=avatar]]:size-7 [&_svg]:size-5",
        avatarsEnabled
          ? isFamilyChild
            ? focusMode
              ? "grid-cols-[3rem_minmax(0,1fr)]"
              : "grid-cols-[2.5rem_minmax(0,1fr)]"
            : focusMode
              ? "grid-cols-[2rem_minmax(0,1fr)]"
              : "grid-cols-[1.5rem_minmax(0,1fr)]"
          : "grid-cols-[1.25rem_minmax(0,1fr)]",
        selected
          ? "active text-primary font-semibold"
          : "text-muted-foreground hover:text-foreground",
        canResolve && "can-resolve",
        selected && canResolve && "has-session-action",
      )}
    >
      {renamingValue === null && (
        <div
          data-slot="session-leading"
          className="relative flex h-full items-center justify-center"
        >
          <DepthRails
            depth={session.familyDepth ?? 0}
            className="pointer-events-none absolute inset-y-0 left-0 w-2 flex-none"
          />
          {isFamilyParent && (
            <IconButton
              className={cn(
                "size-5 shrink-0 text-muted-foreground transition-transform",
                avatarsEnabled && "absolute right-full",
                familyCollapsed && "-rotate-90",
              )}
              tooltip={familyCollapsed ? "Expand child sessions" : "Collapse child sessions"}
              ariaLabel={`${familyCollapsed ? "Expand" : "Collapse"} children of ${session.title}`}
              aria-expanded={!familyCollapsed}
              data-cake-hint="off"
              onClick={() => onToggleFamily?.(session.sessionId)}
            >
              <ChevronIcon />
            </IconButton>
          )}
          {avatarsEnabled ? (
            canSetLabels ? (
              <AvatarLabelPicker
                interaction={avatarInteraction}
                seed={avatarSeed}
                labels={availableLabels}
                value={labelIds}
                className="size-6"
                onChange={(nextLabelIds) => onSetLabels?.(session.sessionId, nextLabelIds)}
              />
            ) : (
              <Avatar
                interaction={avatarInteraction}
                kind="session"
                resolved={resolved}
                seed={avatarSeed}
                labelColors={labels.map((label) => label.color)}
                title={
                  resolved
                    ? "Resolved session"
                    : labels.map((label) => label.name).join(", ") || "No labels"
                }
                role="img"
                aria-label={
                  resolved
                    ? "Resolved session"
                    : labels.length
                      ? `Labels: ${labels.map((label) => label.name).join(", ")}`
                      : "No labels"
                }
              />
            )
          ) : (
            labels[0] && (
              <LabelSwatch
                color={labels[0].color}
                className={isFamilyParent ? "absolute -left-2" : undefined}
                title={labels.map((label) => label.name).join(", ")}
                role="img"
                aria-label={`Labels: ${labels.map((label) => label.name).join(", ")}`}
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
          ref={navigationRef}
          motionFeedback
          className={cn(
            "session-row col-start-2 h-full bg-transparent py-0 hover:bg-transparent [&>button]:h-full",
            focusMode && "text-sm",
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
                else if (action?.action === "resolve") onResolve(session.sessionId, true);
                else if (action?.action === "unresolve") onResolve(session.sessionId, false);
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
              {source ? (
                <>
                  <span className="flex min-w-0 items-center gap-1" title={source.name}>
                    {source.kind === "cake-chat" ? (
                      <CakeIcon />
                    ) : source.showAvatar ? (
                      <Avatar
                        kind="project"
                        seed={source.avatarSeed}
                        customIcon={source.customIcon}
                        className="size-3.5"
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="truncate">{source.name}</span>
                  </span>
                  <span aria-hidden="true">·</span>
                </>
              ) : (
                branch && (
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
                )
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
