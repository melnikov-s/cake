import { SessionActivityIndicator } from "./session-activity-indicator";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import { useState } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  BackIcon,
  CheckIcon,
  ChevronIcon,
  ExpandIcon,
  PlusIcon,
  SettingsIcon,
  MoreHorizontalIcon,
} from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { SidebarProjectSessionItem } from "./sidebar-project-session-item";
import type { AppShellStore } from "../stores/AppShellStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SidebarStore } from "../stores/SidebarStore";
import type { SidebarSessionListStore } from "../stores/SidebarSessionListStore";
import type { SessionMetadataStore } from "../stores/SessionMetadataStore";
import { ProjectActionDialog, type ProjectAction } from "./project-action-dialog";
import { Avatar } from "./ui/avatar";
import { AnimatedList } from "./ui/animated-list";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";
import type { SortableItemDragHandleProps } from "./ui/sortable-item";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";

export interface SidebarProjectGroupProps {
  store: SidebarStore;
  sessionList: SidebarSessionListStore;
  sessionMetadata: SessionMetadataStore;
  projects: ProjectCatalogStore;
  chat: ProjectWorkbenchStore;
  cakeChat: CakeChatCollectionStore;
  onOpenCakeChat(sessionId: string): void;
  shell: AppShellStore;
  appearance: AppearanceSettingsStore;
  path: string;
  resolved: boolean;
  focusMode?: boolean;
  flattenSessions?: boolean;
  dragHandleProps?: SortableItemDragHandleProps;
  onToggleFocus?(path: string): void;
  onCreateSession(workspacePath: string): void;
  onOpenSession(sessionId: string): void;
  onRemoveProject(path: string, deleteSessions: boolean): Promise<boolean>;
  onOpenSettings(path: string): void;
}

/** One project section in the sidebar: header row plus its visible session rows. */
export const SidebarProjectGroup = observer(function SidebarProjectGroup({
  store,
  sessionList,
  sessionMetadata,
  projects,
  chat,
  cakeChat,
  onOpenCakeChat,
  shell,
  appearance,
  path,
  resolved,
  focusMode = false,
  flattenSessions = false,
  dragHandleProps,
  onToggleFocus,
  onCreateSession,
  onOpenSession,
  onRemoveProject,
  onOpenSettings,
}: SidebarProjectGroupProps) {
  const [projectAction, setProjectAction] = useState<ProjectAction>();
  const [actionBusy, setActionBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const sessions = sessionList.projectSessions(path, resolved);
  const visibleSessions =
    focusMode && !resolved ? sessions : sessionList.visibleProjectSessions(path, resolved);
  const expanded =
    flattenSessions ||
    (focusMode && !resolved) ||
    (resolved
      ? sessionList.isResolvedGroupExpanded(path)
      : sessionList.isActiveGroupExpanded(path));
  const projectChat = !resolved ? cakeChat.projectChat(path) : undefined;
  const projectChatSelected = Boolean(
    projectChat &&
    shell.selection.kind === "cake-chat" &&
    shell.selection.sessionId === projectChat.sessionId,
  );
  const projectActivity = !resolved
    ? sessionList.projectActivityForDisplay(path, expanded)
    : undefined;
  const empty = sessions.length === 0;
  const hasMore = resolved
    ? sessionList.hasMoreResolvedProjectSessions(path)
    : !focusMode && sessions.length > visibleSessions.length;
  return (
    <div
      data-slot="project-group"
      className={cn("mb-3 last:mb-0", empty && "mb-1")}
      data-focus-mode={focusMode ? "true" : undefined}
    >
      {!flattenSessions && (
        <div
          data-slot="project-header"
          data-session-id={projectChat?.sessionId}
          className={cn(
            "group/proj grid h-8 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 rounded-md pl-1 pr-2 select-none text-muted-foreground transition-colors [@media(pointer:coarse)]:h-auto [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:[&_.icon-button]:opacity-100",
            appearance.projectAvatarsEnabled && "grid-cols-[auto_auto_minmax(0,1fr)_auto]",
            focusMode &&
              "h-11 gap-2 pl-1.5 text-foreground [&_[data-slot=avatar]]:size-7 [&_svg]:size-5",
            projectChatSelected && "bg-sidebar-active text-primary",
          )}
          title={path}
        >
          <IconButton
            className={cn(
              "size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground",
              focusMode ? "size-7" : "transition-transform duration-150",
              !focusMode && !expanded && "-rotate-90",
            )}
            aria-expanded={focusMode ? undefined : expanded}
            tooltip={focusMode ? "Exit project focus" : expanded ? "Collapse" : "Expand"}
            ariaLabel={
              focusMode
                ? `Exit focus mode for ${projects.nameFromPath(path)}`
                : `${expanded ? "Collapse" : "Expand"} ${projects.nameForPath(path)}${resolved ? " resolved" : ""}`
            }
            onClick={() =>
              focusMode
                ? onToggleFocus?.(path)
                : resolved
                  ? sessionList.toggleResolvedGroupExpanded(path)
                  : sessionList.toggleActiveGroupExpanded(path)
            }
          >
            {focusMode ? <BackIcon /> : <ChevronIcon />}
          </IconButton>
          {appearance.projectAvatarsEnabled && (
            <Avatar
              kind="project"
              seed={projects.nameForPath(path)}
              customIcon={projects.find(path)?.settings?.icon}
              title={`Avatar for ${projects.nameForPath(path)}`}
              aria-hidden="true"
            />
          )}
          <Button
            data-slot="project-label"
            variant="ghost"
            {...dragHandleProps}
            className={cn(
              "h-7 w-full min-w-0 justify-start px-1 text-sm font-medium text-inherit hover:text-foreground",
              dragHandleProps && "cursor-grab active:cursor-grabbing",
              focusMode && "h-9 text-base font-semibold",
              projectChatSelected && "hover:bg-transparent",
            )}
            type="button"
            aria-current={projectChatSelected ? "page" : undefined}
            aria-label={
              resolved
                ? `${expanded ? "Collapse" : "Expand"} ${projects.nameForPath(path)} resolved`
                : `Open Project Chat for ${projects.nameFromPath(path)}`
            }
            onClick={() => {
              if (resolved) sessionList.toggleResolvedGroupExpanded(path);
              else if (projectChat) onOpenCakeChat(projectChat.sessionId);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              void store
                .showProjectContextMenu(path, event.clientX, event.clientY)
                .then((action) => {
                  if (action === "settings") onOpenSettings(path);
                  else if (action === "remove-project" || action === "delete-resolved-worktrees")
                    setProjectAction(action);
                });
            }}
          >
            <span className="truncate">{projects.nameForPath(path)}</span>
          </Button>
          {/* A stable compact action track; opacity never changes the label's width. */}
          {!resolved && (
            <div className="grid items-center [@media(pointer:coarse)]:col-span-full [@media(pointer:coarse)]:justify-self-end">
              {(projectChat || projectActivity) && (
                <div
                  data-slot="project-chat-status"
                  className={cn(
                    "pointer-events-none col-start-1 row-start-1 flex w-6 items-center justify-center justify-self-end transition-opacity group-hover/proj:opacity-0 group-has-[:focus-visible]/proj:opacity-0 [@media(pointer:coarse)]:hidden",
                    actionsOpen && "opacity-0",
                  )}
                >
                  <SessionActivityIndicator activity={projectActivity} />
                </div>
              )}
              <div
                data-slot="project-actions"
                className={cn(
                  "col-start-1 row-start-1 flex items-center opacity-0 transition-opacity group-hover/proj:opacity-100 group-has-[:focus-visible]/proj:opacity-100 [@media(pointer:coarse)]:opacity-100",
                  actionsOpen && "opacity-100",
                )}
              >
                <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
                  <PopoverIconTrigger
                    className="size-6 flex items-center justify-center rounded text-muted-foreground hover:bg-sidebar-hover hover:text-foreground"
                    tooltip="Project actions"
                    ariaLabel={`Project actions for ${projects.nameFromPath(path)}`}
                    aria-haspopup="menu"
                  >
                    <MoreHorizontalIcon />
                  </PopoverIconTrigger>
                  <PopoverContent
                    side="bottom"
                    align="end"
                    role="menu"
                    aria-label={`Project actions for ${projects.nameFromPath(path)}`}
                    className="w-48 rounded-lg p-1 [&_button]:transition-colors"
                  >
                    {!focusMode && (
                      <Button
                        variant="ghost"
                        role="menuitem"
                        className="h-8 w-full justify-start gap-2 px-2"
                        aria-label={`Focus on ${projects.nameFromPath(path)}`}
                        onClick={() => {
                          setActionsOpen(false);
                          onToggleFocus?.(path);
                        }}
                      >
                        <ExpandIcon /> Focus on project
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      role="menuitem"
                      className="h-8 w-full justify-start gap-2 px-2"
                      aria-label={`Open settings for ${projects.nameFromPath(path)}`}
                      onClick={() => {
                        setActionsOpen(false);
                        onOpenSettings(path);
                      }}
                    >
                      <SettingsIcon /> Project settings
                    </Button>
                    {(["date", "label"] as const).map((sort) => {
                      const selected = sessionList.projectSessionSort(path) === sort;
                      return (
                        <Button
                          key={sort}
                          variant="ghost"
                          role="menuitemradio"
                          aria-checked={selected}
                          className="h-8 w-full justify-start gap-2 rounded-md px-2 text-xs font-normal"
                          onClick={() => {
                            sessionList.setProjectSessionSort(path, sort);
                            setActionsOpen(false);
                          }}
                        >
                          <span className="flex w-4 justify-center">
                            {selected && <CheckIcon />}
                          </span>
                          By {sort === "date" ? "date" : "label"}
                        </Button>
                      );
                    })}
                  </PopoverContent>
                </Popover>
                <IconButton
                  className="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover"
                  tooltip="New chat"
                  ariaLabel={`New chat in ${projects.nameFromPath(path)}`}
                  onClick={() => onCreateSession(path)}
                >
                  <PlusIcon />
                </IconButton>
              </div>
            </div>
          )}
        </div>
      )}
      {expanded && (
        <AnimatedList
          className={cn(
            "mt-1 flex flex-col gap-1 pl-1.5",
            focusMode && "mt-1.5 gap-1.5 pl-5",
            flattenSessions && "mt-0 pl-0",
          )}
        >
          {visibleSessions.map((session) => (
            <SidebarProjectSessionItem
              key={session.sessionId}
              store={store}
              sessionList={sessionList}
              sessionMetadata={sessionMetadata}
              appearance={appearance}
              session={session}
              selected={
                shell.selection.kind === "project-session" &&
                shell.selection.sessionId === session.sessionId
              }
              paneNumber={chat.paneNumber?.(session.sessionId)}
              resolved={resolved}
              focusMode={focusMode}
              onOpenSession={onOpenSession}
            />
          ))}
          {hasMore && (
            <Button
              variant="ghost"
              className={cn(
                "h-7 justify-start px-2 text-sm text-muted-foreground hover:text-foreground",
                focusMode && "h-9 text-sm",
              )}
              onClick={() => sessionList.showMoreSessions(path, resolved)}
            >
              Show more
            </Button>
          )}
        </AnimatedList>
      )}
      {projectAction && (
        <ProjectActionDialog
          action={projectAction}
          projectName={projects.nameForPath(path)}
          sessionCount={store.projectSessionCount(path)}
          resolvedWorktreeCount={store.resolvedWorktreeCount(path)}
          busy={actionBusy}
          onCancel={() => setProjectAction(undefined)}
          onRemove={(deleteSessions) => {
            setActionBusy(true);
            void onRemoveProject(path, deleteSessions).then((removed) => {
              if (!removed) setActionBusy(false);
            });
          }}
          onDeleteResolvedWorktrees={() => {
            setActionBusy(true);
            void chat.deleteResolvedWorktrees(path).then((deleted) => {
              setActionBusy(false);
              if (deleted) setProjectAction(undefined);
            });
          }}
        />
      )}
    </div>
  );
});
