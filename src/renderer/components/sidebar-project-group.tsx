import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import { ChevronIcon, FolderIcon, PlusIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { SidebarSessionItem } from "./sidebar-session-item";
import type { AppShellStore } from "../stores/AppShellStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { SidebarStore } from "../stores/SidebarStore";

export interface SidebarProjectGroupProps {
  store: SidebarStore;
  projects: ProjectCatalogStore;
  chat: ProjectWorkbenchStore;
  shell: AppShellStore;
  path: string;
  resolved: boolean;
  onCreateSession(workspacePath: string): void;
  onOpenSession(sessionId: string): void;
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
}: SidebarProjectGroupProps) {
  const collapseKey = `${resolved ? "resolved" : "active"}:${path}`;
  const collapsed = store.isGroupCollapsed(collapseKey);
  const sessions = store.projectSessions(path, resolved);
  if (resolved && sessions.length === 0) return null;
  const visibleSessions = sessions.slice(0, store.sessionLimit(path, resolved));
  const empty = sessions.length === 0;
  return (
    <div className={cn("project-group mb-3 last:mb-0", empty && "project-group-empty mb-1")}>
      <div
        className="project-row group/proj flex h-8 w-full items-center gap-1 px-1 select-none text-muted-foreground"
        title={path}
      >
        <IconButton
          className={cn(
            "project-disclosure size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-transform duration-150",
            collapsed && "collapsed -rotate-90",
            empty && "no-sessions invisible",
          )}
          aria-expanded={!collapsed}
          tooltip={collapsed ? "Expand" : "Collapse"}
          ariaLabel={`${collapsed ? "Expand" : "Collapse"} ${projects.nameForPath(path)}${resolved ? " resolved" : ""}`}
          onClick={() => store.toggleGroupCollapsed(collapseKey)}
        >
          <ChevronIcon />
        </IconButton>
        <button
          className="project-label flex min-w-0 flex-1 items-center gap-2 h-7 px-1 rounded text-left text-xs font-medium text-inherit hover:text-foreground"
          type="button"
          aria-label={
            resolved
              ? `${collapsed ? "Expand" : "Collapse"} ${projects.nameForPath(path)} resolved`
              : `Start new chat in ${projects.nameFromPath(path)}`
          }
          onClick={() =>
            resolved ? store.toggleGroupCollapsed(collapseKey) : onCreateSession(path)
          }
        >
          <FolderIcon />
          <span className="truncate">{projects.nameForPath(path)}</span>
        </button>
        {!resolved && (
          <IconButton
            className="project-add size-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-sidebar-hover opacity-0 group-hover/proj:opacity-100 focus-visible:opacity-100 transition-opacity"
            tooltip="New chat"
            ariaLabel={`New chat in ${projects.nameFromPath(path)}`}
            onClick={() => onCreateSession(path)}
          >
            <PlusIcon />
          </IconButton>
        )}
      </div>
      {!collapsed && (
        <div className="flex flex-col pl-6 space-y-0.5 mt-0.5">
          {visibleSessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              store={store}
              chat={chat}
              shell={shell}
              session={session}
              resolved={resolved}
              onOpen={onOpenSession}
            />
          ))}
          {sessions.length > visibleSessions.length && (
            <button
              type="button"
              className="session-more text-left text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-sidebar-hover transition-colors"
              onClick={() => store.showMoreSessions(path, resolved)}
            >
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
});
