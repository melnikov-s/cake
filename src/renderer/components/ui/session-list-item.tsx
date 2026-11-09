import { useEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectIcon, SessionLabel } from "../../../contracts/application/application-data";
import type { WorktreeCatalogEntry } from "../../../contracts/worktrees/managed-worktree-data";
import { isActiveSessionActivity, type SessionActivity } from "../../lib/session-activity";
import { cn } from "../../lib/utils";
import { SessionActivityIndicator } from "../session-activity-indicator";
import { WorktreeStatusIcon } from "../worktree-status-icon";
import { Avatar } from "./avatar";
import { AvatarLabelPicker } from "./avatar-label-picker";
import { Badge } from "./badge";
import { DepthRails } from "./depth-rails";
import { IconButton } from "./icon-button";
import { CakeIcon, ChevronIcon, ResolveIcon, RestoreIcon } from "./icons";
import { LabelSwatch } from "./label-swatch";
import { associationHighlightClassName, NavItem, type NavItemProps } from "./nav-item";
import { SessionActivityTime } from "./session-activity-time";
import { CommitChangeStatsText } from "./commit-change-stats";

export interface SessionListItemProps {
  session: {
    sessionId: string;
    title: string;
    modifiedAt: string;
    workingStartedAt?: number;
    draft?: boolean;
    worktreeName?: string;
    familyParentSessionId?: string;
    familyChildSessionIds?: readonly string[];
    familyDepth?: number;
  };
  managedWorktree?: Pick<
    WorktreeCatalogEntry,
    "branch" | "baseBranch" | "defaultBranch" | "parentWorktreePath" | "state" | "commitStats"
  >;
  selected: boolean;
  /** Sidebar navigation opens on press; destination pickers retain click activation. */
  activateOnMouseDown?: boolean;
  /** Scroll the row into view when it becomes (or mounts) selected; navigation lists opt in. */
  revealWhenSelected?: boolean;
  /** Advisory to-do association; never replaces actual selection. */
  associated?: boolean;
  resolved: boolean;
  activity?: SessionActivity;
  /** Effective activity comes from descendants, not the parent's own work. */
  childrenWorking?: boolean;
  activityTime: string;
  /** Recursive navigation keeps an idle status track even without actions. */
  showIdleStatus?: boolean;
  labels: readonly SessionLabel[];
  avatarSeed: string;
  avatarsEnabled: boolean;
  charactersEnabled?: boolean;
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
  familyCollapsed?: boolean;
  labelIds?: readonly string[];
  availableLabels?: readonly SessionLabel[];
  renameInput?: ReactNode;
  /** Listbox option semantics for session pickers; navigation remains the default. */
  actionProps?: NavItemProps["actionProps"];
  onOpen(sessionId: string): void;
  onToggleFamily?(sessionId: string): void;
  onSetLabels?(sessionId: string, labelIds: readonly string[]): void;
  onResolve?(sessionId: string, resolved: boolean): void;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
}

/** Authoritative session-row presentation, shared by navigation and destination pickers. */
export const SessionListItem = observer(function SessionListItem({
  session,
  managedWorktree,
  selected,
  activateOnMouseDown = false,
  revealWhenSelected = false,
  associated = false,
  resolved,
  activity,
  childrenWorking,
  activityTime,
  showIdleStatus = false,
  labels,
  avatarSeed,
  avatarsEnabled,
  charactersEnabled = false,
  source,
  focusMode = false,
  familyCollapsed,
  labelIds = [],
  availableLabels = [],
  renameInput,
  actionProps,
  onOpen,
  onToggleFamily,
  onSetLabels,
  onResolve,
  onContextMenu,
}: SessionListItemProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // "nearest" leaves an already visible row exactly where it is.
    if (selected && revealWhenSelected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected, revealWhenSelected]);
  const avatarVariant = charactersEnabled ? "artwork" : "square";
  const avatarInteraction = charactersEnabled
    ? { target: rowRef, activationTarget: navigationRef }
    : undefined;
  const isFamilyParent = Boolean(session.familyChildSessionIds?.length);
  const isFamilyChild =
    Boolean(session.familyParentSessionId) && session.familyParentSessionId !== session.sessionId;
  // Resolve is never gated by activity: on hover/focus it replaces whatever status dot is shown.
  const canResolve = !isFamilyChild && Boolean(onResolve);
  const canSetLabels = !session.draft && !resolved && Boolean(onSetLabels);
  const branch = session.draft
    ? undefined
    : (session.worktreeName ?? managedWorktree?.branch.replace(/^agent\//, ""));
  const baseBranch = managedWorktree?.baseBranch.replace(/^agent\//, "");
  const defaultBranch = managedWorktree?.defaultBranch;
  const showBaseBranch =
    baseBranch !== undefined &&
    (defaultBranch
      ? managedWorktree?.baseBranch !== defaultBranch
      : managedWorktree?.baseBranch !== "main" && managedWorktree?.baseBranch !== "master");
  const hasActivityTime = isActiveSessionActivity(activity) || Boolean(activityTime.trim());
  const commitStats = session.draft ? undefined : managedWorktree?.commitStats;
  const hasStats = Boolean(commitStats?.commitCount);
  const hasDescription = Boolean(source || hasActivityTime || branch || hasStats);
  return (
    <div
      ref={rowRef}
      data-animated-list-key={session.sessionId}
      data-session-id={session.sessionId}
      data-navigation-item=""
      data-navigation-active={selected}
      data-associated={associated && !selected ? "true" : undefined}
      data-family-role={isFamilyChild ? "child" : isFamilyParent ? "parent" : "root"}
      className={cn(
        "session-item group group/session relative grid min-h-11 w-full items-center rounded-md text-sm tracking-[-0.005em] select-none transition-colors duration-200 ease-out motion-reduce:transition-none",
        focusMode && "min-h-14 text-sm",
        focusMode && charactersEnabled && "[&_[data-slot=avatar]]:size-7",
        avatarsEnabled
          ? isFamilyChild
            ? focusMode
              ? "grid-cols-[4.25rem_minmax(0,1fr)]"
              : "grid-cols-[3.75rem_minmax(0,1fr)]"
            : focusMode
              ? "grid-cols-[3.25rem_minmax(0,1fr)]"
              : "grid-cols-[2.75rem_minmax(0,1fr)]"
          : "grid-cols-[1.25rem_minmax(0,1fr)]",
        selected
          ? "active text-sidebar-selection-foreground font-medium"
          : "text-muted-foreground hover:text-foreground",
        actionProps?.role === "option" &&
          (selected ? "bg-sidebar-active" : "hover:bg-sidebar-hover"),
        associated &&
          !selected && [
            associationHighlightClassName,
            "hover:bg-sidebar-hover focus-within:bg-sidebar-hover",
          ],
        canResolve && "can-resolve",
        selected && canResolve && "has-session-action",
      )}
    >
      {!renameInput && (
        <div
          data-slot="session-leading"
          className={cn(
            "relative grid h-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center justify-items-center",
            !avatarsEnabled && "grid-cols-1",
          )}
        >
          <DepthRails
            depth={session.familyDepth ?? 0}
            className="pointer-events-none absolute inset-y-0 left-0 w-2 flex-none"
          />
          {isFamilyParent && onToggleFamily && (
            <IconButton
              iconSize="inline"
              className={cn(
                "size-5 shrink-0 text-muted-foreground transition-transform",
                avatarsEnabled && "col-start-1 row-start-1",
                familyCollapsed && "-rotate-90",
              )}
              tooltip={familyCollapsed ? "Expand child sessions" : "Collapse child sessions"}
              ariaLabel={`${familyCollapsed ? "Expand" : "Collapse"} children of ${session.title}`}
              aria-expanded={!familyCollapsed}
              data-cake-hint="off"
              onClick={() => onToggleFamily(session.sessionId)}
            >
              <ChevronIcon />
            </IconButton>
          )}
          {avatarsEnabled ? (
            canSetLabels ? (
              <AvatarLabelPicker
                variant={avatarVariant}
                interaction={avatarInteraction}
                seed={avatarSeed}
                labels={availableLabels}
                value={labelIds}
                className="col-start-2 row-start-1 size-6"
                onChange={(next) => onSetLabels?.(session.sessionId, next)}
              />
            ) : (
              <Avatar
                variant={avatarVariant}
                interaction={avatarInteraction}
                kind="session"
                className="col-start-2 row-start-1"
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
      {renameInput ?? (
        <NavItem
          ref={navigationRef}
          actionProps={actionProps}
          activateOnMouseDown={activateOnMouseDown}
          className={cn(
            "session-row col-start-2 h-full bg-transparent py-1.5 hover:bg-transparent [&>button]:h-full",
            focusMode && "py-2 text-sm",
          )}
          active={selected}
          onClick={() => onOpen(session.sessionId)}
          onContextMenu={onContextMenu}
          label={
            <span className="session-title block min-w-0 truncate" title={session.title}>
              {session.title}
            </span>
          }
          badge={
            session.draft && (
              <span className="flex items-center gap-1">
                {session.draft && (
                  <Badge variant="outline" size="xs" className="text-muted-foreground">
                    Draft
                  </Badge>
                )}
              </span>
            )
          }
          description={
            hasDescription && (
              <span
                data-slot="session-description"
                className={cn(
                  "flex w-full min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs font-normal leading-none",
                  focusMode && "text-xs leading-tight",
                  selected ? "text-sidebar-selection-foreground/80" : "text-muted-foreground/80",
                )}
              >
                {hasActivityTime && (
                  <SessionActivityTime
                    modifiedAt={session.modifiedAt}
                    workingStartedAt={session.workingStartedAt}
                    activity={activity}
                    childrenWorking={childrenWorking}
                    activityTime={activityTime}
                    focusMode={focusMode}
                  />
                )}
                {hasStats && (
                  <>
                    {hasActivityTime && <span aria-hidden="true">·</span>}
                    <CommitChangeStatsText stats={commitStats} />
                  </>
                )}
                {branch && (
                  <>
                    {(hasActivityTime || hasStats) && <span aria-hidden="true">·</span>}
                    <span
                      data-slot="session-worktree"
                      className="inline-flex min-w-0 items-center gap-1"
                      title={branch}
                    >
                      {managedWorktree && (
                        <WorktreeStatusIcon state={managedWorktree.state} className="shrink-0" />
                      )}
                      <span className="min-w-0 truncate">{branch}</span>
                      {showBaseBranch && (
                        <>
                          <span aria-hidden="true">→</span>
                          <span className="truncate">{baseBranch}</span>
                        </>
                      )}
                    </span>
                  </>
                )}
                {source && (
                  <>
                    {(hasActivityTime || hasStats || branch) && <span aria-hidden="true">·</span>}
                    <span
                      data-slot="session-source"
                      className="flex min-w-0 items-center gap-1"
                      title={source.name}
                    >
                      {source.kind === "cake-chat" ? (
                        <CakeIcon />
                      ) : source.showAvatar ? (
                        <Avatar
                          kind="project"
                          seed={source.avatarSeed}
                          customIcon={source.customIcon}
                          className="size-[18px]"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className="truncate">{source.name}</span>
                    </span>
                  </>
                )}
              </span>
            )
          }
          trailing={
            (activity || canResolve || showIdleStatus) && (
              <div
                className="session-meta relative grid size-6 shrink-0 place-items-center"
                data-slot="own-activity"
                aria-label={activity ? undefined : "Idle"}
                title={activity ? undefined : "Idle"}
              >
                {activity && (
                  <span
                    className={cn(
                      "pointer-events-none col-start-1 row-start-1 flex items-center justify-center",
                      canResolve &&
                        "group-hover/session:opacity-0 group-focus-within/session:opacity-0",
                    )}
                  >
                    <SessionActivityIndicator activity={activity} />
                  </span>
                )}
                {canResolve && (
                  <IconButton
                    iconSize="inline"
                    className={cn(
                      "session-resolve-action col-start-1 row-start-1 size-6 flex items-center justify-center rounded transition-opacity",
                      selected && !activity
                        ? "text-sidebar-selection-foreground/80 opacity-100 hover:bg-sidebar-hover hover:text-sidebar-selection-foreground"
                        : "text-muted-foreground opacity-0 hover:bg-sidebar-hover hover:text-foreground group-hover/session:opacity-100 group-focus-within/session:opacity-100",
                    )}
                    tooltip={resolved ? "Restore" : "Resolve"}
                    ariaLabel={`${resolved ? "Restore" : "Resolve"} ${session.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onResolve?.(session.sessionId, !resolved);
                    }}
                  >
                    {resolved ? <RestoreIcon /> : <ResolveIcon />}
                  </IconButton>
                )}
              </div>
            )
          }
        />
      )}
    </div>
  );
});
