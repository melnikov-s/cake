import { useEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectIcon, SessionLabel } from "../../../contracts/application/application-data";
import type { WorktreeRecord } from "../../../contracts/worktrees/managed-worktree-data";
import { type SessionActivity } from "../../lib/session-activity";
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
  managedWorktree?: Pick<WorktreeRecord, "branch" | "baseBranch" | "parentWorktreePath" | "state">;
  selected: boolean;
  /** Sidebar navigation opens on press; destination pickers retain click activation. */
  activateOnMouseDown?: boolean;
  /** Scroll the row into view when it becomes (or mounts) selected; navigation lists opt in. */
  revealWhenSelected?: boolean;
  /** Advisory to-do association; never replaces actual selection. */
  associated?: boolean;
  paneNumber?: number;
  resolved: boolean;
  activity?: SessionActivity;
  activityTime: string;
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
  paneNumber,
  resolved,
  activity,
  activityTime,
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
  const canResolve = (!activity || activity === "unread") && !isFamilyChild && Boolean(onResolve);
  const canSetLabels = !session.draft && !resolved && Boolean(onSetLabels);
  const branch = session.draft
    ? undefined
    : (session.worktreeName ?? managedWorktree?.branch.replace(/^agent\//, ""));
  const baseBranch = managedWorktree?.baseBranch.replace(/^agent\//, "");
  const showBaseBranch = baseBranch !== undefined && baseBranch !== "main";
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
        focusMode && "min-h-14 text-sm [&_svg]:size-5",
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
          ? "active text-primary font-medium"
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
                "flex w-full min-w-0 items-center gap-1.5 text-xs font-normal leading-none",
                focusMode && "text-xs leading-tight",
                selected ? "text-primary/80" : "text-muted-foreground/80",
              )}
            >
              {source && (
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
              )}
              <SessionActivityTime
                modifiedAt={session.modifiedAt}
                workingStartedAt={session.workingStartedAt}
                activity={activity}
                activityTime={activityTime}
                focusMode={focusMode}
              />
              {branch && (
                <>
                  <span aria-hidden="true">·</span>
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
                </>
              )}
            </span>
          }
          trailing={
            (activity || canResolve) && (
              <div className="session-meta relative grid size-6 shrink-0 place-items-center">
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
                    className={cn(
                      "session-resolve-action col-start-1 row-start-1 size-6 flex items-center justify-center rounded transition-opacity",
                      selected && !activity
                        ? "text-primary/80 opacity-100 hover:bg-primary/10 hover:text-primary"
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
