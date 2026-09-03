import { useState } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ChevronIcon, FolderIcon, PlusIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { SidebarSessionItem } from "./sidebar-session-item";
import type { AppShellStore } from "../stores/AppShellStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SidebarStore } from "../stores/SidebarStore";
import { ProjectActionDialog, type ProjectAction } from "./project-action-dialog";

export interface SidebarProjectGroupProps {
  store: SidebarStore;
  projects: ProjectCatalogStore;
  chat: ProjectWorkbenchStore;
  shell: AppShellStore;
  path: string;
  resolved: boolean;
  onCreateSession(workspacePath: string): void;
  onOpenSession(sessionId: string): void;
  onRemoveProject(path: string, deleteSessions: boolean): Promise<boolean>;
}

/** One project section in the sidebar: header row plus its visible session rows. */
export const SidebarProjectGroup = observer(function SidebarProjectGroup({
  store,
  projects,
  chat,
  shell,
  path,
  resolved,
  onCreateSession,
  onOpenSession,
  onRemoveProject,
}: SidebarProjectGroupProps) {
  const [projectAction, setProjectAction] = useState<ProjectAction>();
  const [actionBusy, setActionBusy] = useState(false);
  const sessions = store.projectSessions(path, resolved);
  const expanded = !resolved || store.isResolvedGroupExpanded(path);
  const empty = sessions.length === 0;
  return (
    <div data-slot="project-group" className={cn("mb-3 last:mb-0", empty && "mb-1")}>
      <div
        className="group/proj flex h-8 w-full items-center gap-1 px-1 select-none text-muted-foreground"
        title={path}
      >
        {resolved && (
          <IconButton
            className={cn(
              "size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-transform duration-150",
              !expanded && "-rotate-90",
            )}
            aria-expanded={expanded}
            tooltip={expanded ? "Collapse" : "Expand"}
            ariaLabel={`${expanded ? "Collapse" : "Expand"} ${projects.nameForPath(path)} resolved`}
            onClick={() => store.toggleResolvedGroupExpanded(path)}
          >
            <ChevronIcon />
          </IconButton>
        )}
        <Button
          data-slot="project-label"
          variant="ghost"
          className="h-7 min-w-0 flex-1 justify-start gap-2 px-1 text-xs font-medium text-inherit hover:text-foreground"
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
              if (action) setProjectAction(action);
            });
          }}
        >
          <FolderIcon />
          <span className="truncate">{projects.nameForPath(path)}</span>
        </Button>
        {!resolved && (
          <IconButton
            className="size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity"
            tooltip="New chat"
            ariaLabel={`New chat in ${projects.nameFromPath(path)}`}
            onClick={() => onCreateSession(path)}
          >
            <PlusIcon />
          </IconButton>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col pl-6 space-y-0.5 mt-0.5">
          {sessions.map((session) => (
            <SidebarSessionItem
              key={session.sessionId}
              store={store}
              session={session}
              selected={
                shell.selection.kind === "project-session" &&
                shell.selection.sessionId === session.sessionId
              }
              resolved={resolved}
              activity={store.sessionActivity(session.sessionId)}
              onOpen={onOpenSession}
              onRename={(sessionId, name) =>
                void chat.sessionManagementStore.renameSession(sessionId, name)
              }
              onResolve={(sessionId, nextResolved) =>
                void store.setSessionResolved(sessionId, nextResolved)
              }
              onDelete={(sessionId) => void store.deleteSession(sessionId)}
              onMarkUnread={(sessionId, unread) => void store.setSessionUnread(sessionId, unread)}
            />
          ))}
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
