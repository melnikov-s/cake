import { observer } from "r-state-tree/react";
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
    <div className={`project-group ${empty ? "project-group-empty" : ""}`}>
      <div className="project-row" title={path}>
        <IconButton
          className={`project-disclosure ${collapsed ? "collapsed" : ""} ${empty ? "no-sessions" : ""}`}
          aria-expanded={!collapsed}
          tooltip={collapsed ? "Expand" : "Collapse"}
          ariaLabel={`${collapsed ? "Expand" : "Collapse"} ${projects.nameForPath(path)}${resolved ? " resolved" : ""}`}
          onClick={() => store.toggleGroupCollapsed(collapseKey)}
        >
          <ChevronIcon />
        </IconButton>
        <button
          className="project-label"
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
          <span>{projects.nameForPath(path)}</span>
        </button>
        {!resolved && (
          <IconButton
            className="project-add"
            tooltip="New chat"
            ariaLabel={`New chat in ${projects.nameFromPath(path)}`}
            onClick={() => onCreateSession(path)}
          >
            <PlusIcon />
          </IconButton>
        )}
      </div>
      {!collapsed &&
        visibleSessions.map((session) => (
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
      {!collapsed && sessions.length > visibleSessions.length && (
        <button className="session-more" onClick={() => store.showMoreSessions(path, resolved)}>
          Show more
        </button>
      )}
    </div>
  );
});
