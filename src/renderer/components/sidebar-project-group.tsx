import { useState } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  ChevronIcon,
  ExpandIcon,
  KanbanIcon,
  PlusIcon,
  SettingsIcon,
  ShrinkIcon,
} from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { SidebarSessionItem } from "./sidebar-session-item";
import type { AppShellStore } from "../stores/AppShellStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SidebarStore } from "../stores/SidebarStore";
import { ProjectActionDialog, type ProjectAction } from "./project-action-dialog";
import { Avatar } from "./ui/avatar";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";

export interface SidebarProjectGroupProps {
  store: SidebarStore;
  projects: ProjectCatalogStore;
  chat: ProjectWorkbenchStore;
  shell: AppShellStore;
  appearance: AppearanceSettingsStore;
  path: string;
  resolved: boolean;
  focusMode?: boolean;
  onToggleFocus?(path: string): void;
  onCreateSession(workspacePath: string): void;
  onOpenSession(sessionId: string): void;
  onRemoveProject(path: string, deleteSessions: boolean): Promise<boolean>;
  onOpenSettings(path: string): void;
  onOpenKanban(path: string): void;
}

/** One project section in the sidebar: header row plus its visible session rows. */
export const SidebarProjectGroup = observer(function SidebarProjectGroup({
  store,
  projects,
  chat,
  shell,
  appearance,
  path,
  resolved,
  focusMode = false,
  onToggleFocus,
  onCreateSession,
  onOpenSession,
  onRemoveProject,
  onOpenSettings,
  onOpenKanban,
}: SidebarProjectGroupProps) {
  const [projectAction, setProjectAction] = useState<ProjectAction>();
  const [actionBusy, setActionBusy] = useState(false);
  const sessions = store.projectSessions(path, resolved);
  const visibleSessions = store.visibleProjectSessions(path, resolved);
  const expanded = resolved
    ? store.isResolvedGroupExpanded(path)
    : store.isActiveGroupExpanded(path);
  const empty = sessions.length === 0;
  const hasMore = resolved
    ? store.hasMoreResolvedProjectSessions(path)
    : sessions.length > visibleSessions.length;
  const kanbanSelected = shell.selection.kind === "kanban" && shell.selection.projectPath === path;
  return (
    <div
      data-slot="project-group"
      className={cn("mb-3 last:mb-0", empty && "mb-1")}
      data-focus-mode={focusMode ? "true" : undefined}
    >
      <div
        className={cn(
          "group/proj flex h-8 w-full items-center gap-1 px-1 select-none text-muted-foreground",
          focusMode &&
            "h-11 gap-2 px-1.5 text-foreground [&_[data-slot=avatar]]:size-7 [&_svg]:size-5",
        )}
        title={path}
      >
        <IconButton
          className={cn(
            "size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-transform duration-150",
            focusMode && "size-7",
            !expanded && "-rotate-90",
          )}
          aria-expanded={expanded}
          tooltip={expanded ? "Collapse" : "Expand"}
          ariaLabel={`${expanded ? "Collapse" : "Expand"} ${projects.nameForPath(path)}${resolved ? " resolved" : ""}`}
          onClick={() =>
            resolved
              ? store.toggleResolvedGroupExpanded(path)
              : store.toggleActiveGroupExpanded(path)
          }
        >
          <ChevronIcon />
        </IconButton>
        {appearance.projectAvatarsEnabled && (
          <Avatar
            kind="project"
            seed={projects.nameForPath(path)}
            title={`Avatar for ${projects.nameForPath(path)}`}
            aria-hidden="true"
          />
        )}
        <Button
          data-slot="project-label"
          variant="ghost"
          className={cn(
            "h-7 min-w-0 flex-1 justify-start px-1 text-xs font-medium text-inherit hover:text-foreground",
            focusMode && "h-9 text-base font-semibold",
          )}
          type="button"
          aria-label={
            resolved
              ? `${expanded ? "Collapse" : "Expand"} ${projects.nameForPath(path)} resolved`
              : `Start new chat in ${projects.nameFromPath(path)}`
          }
          onClick={() =>
            resolved ? store.toggleResolvedGroupExpanded(path) : onCreateSession(path)
          }
          onContextMenu={(event) => {
            event.preventDefault();
            void store.showProjectContextMenu(path, event.clientX, event.clientY).then((action) => {
              if (action === "settings") onOpenSettings(path);
              else if (action) setProjectAction(action);
            });
          }}
        >
          <span className="truncate">{projects.nameForPath(path)}</span>
        </Button>
        {!resolved && (
          <>
            <IconButton
              className={cn(
                "size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity",
                focusMode && "size-8 opacity-100",
              )}
              tooltip={focusMode ? "Exit project focus" : "Focus on project"}
              ariaLabel={`${focusMode ? "Exit focus mode for" : "Focus on"} ${projects.nameFromPath(path)}`}
              aria-pressed={focusMode}
              onClick={() => onToggleFocus?.(path)}
            >
              {focusMode ? <ShrinkIcon size={19} /> : <ExpandIcon />}
            </IconButton>
            <IconButton
              className={cn(
                "size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity",
                kanbanSelected && "bg-sidebar-hover text-foreground opacity-100",
              )}
              tooltip={kanbanSelected ? "Close Kanban board" : "Open Kanban board"}
              ariaLabel={`${kanbanSelected ? "Close" : "Open"} Kanban board for ${projects.nameFromPath(path)}`}
              aria-pressed={kanbanSelected}
              onClick={() => onOpenKanban(path)}
            >
              <KanbanIcon />
            </IconButton>
            <IconButton
              className="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity"
              tooltip="Project settings"
              ariaLabel={`Open settings for ${projects.nameFromPath(path)}`}
              onClick={() => onOpenSettings(path)}
            >
              <SettingsIcon />
            </IconButton>
            <IconButton
              className="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity"
              tooltip="New chat"
              ariaLabel={`New chat in ${projects.nameFromPath(path)}`}
              onClick={() => onCreateSession(path)}
            >
              <PlusIcon />
            </IconButton>
          </>
        )}
      </div>
      {expanded && (
        <div
          className={cn("mt-0.5 flex flex-col space-y-0.5 pl-4", focusMode && "mt-1 gap-1 pl-5")}
        >
          {visibleSessions.map((session) => (
            <SidebarSessionItem
              key={session.sessionId}
              store={store}
              session={session}
              managedWorktree={store.managedWorktree(session.workingDirectory)}
              selected={
                shell.selection.kind === "project-session" &&
                shell.selection.sessionId === session.sessionId
              }
              paneNumber={chat.paneNumber?.(session.sessionId)}
              resolved={resolved}
              activity={store.sessionActivityForDisplay(session)}
              workflowStatus={store.sessionWorkflowStatus(session.sessionId)}
              avatarSeed={store.sessionAvatarSeed(session.sessionId)}
              avatarsEnabled={appearance.sessionAvatarsEnabled}
              focusMode={focusMode}
              onOpen={onOpenSession}
              onToggleFamily={(sessionId) => store.toggleFamilyCollapsed(sessionId)}
              familyCollapsed={store.isFamilyCollapsed(session.sessionId)}
              onRename={(sessionId, name) =>
                void chat.sessionManagementStore.renameSession(sessionId, name)
              }
              onResolve={(sessionId, nextResolved) =>
                void store.setSessionResolved(sessionId, nextResolved)
              }
              onSetStatus={(sessionId, statusId) =>
                void store.setSessionWorkflowStatus(sessionId, statusId)
              }
              onDelete={(sessionId) => void store.deleteSession(sessionId)}
              onMarkUnread={(sessionId, unread) => void store.setSessionUnread(sessionId, unread)}
            />
          ))}
          {hasMore && (
            <Button
              variant="ghost"
              className={cn(
                "h-7 justify-start px-2 text-xs text-muted-foreground hover:text-foreground",
                focusMode && "h-9 text-sm",
              )}
              onClick={() => store.showMoreSessions(path, resolved)}
            >
              Show more
            </Button>
          )}
        </div>
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
