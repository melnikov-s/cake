import { observer } from "r-state-tree/react";
import { IconButton } from "./ui/icon-button";
import {
  BackIcon,
  ChevronIcon,
  ForwardIcon,
  PlusIcon,
  SettingsIcon,
  SidebarIcon,
} from "./ui/icons";
import { SidebarCakeChatGroup } from "./sidebar-cake-chat-group";
import { SidebarProjectGroup } from "./sidebar-project-group";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { SidebarStore } from "../stores/SidebarStore";
import type { GlobalChatStore } from "../stores/GlobalChatStore";
import type { AppShellStore } from "../stores/AppShellStore";
import { Slot } from "../plugin-runtime";

export const Sidebar = observer(function Sidebar({
  store,
  projects,
  chat,
  cakeChat,
  shell,
  onOpenSettings,
  onOpenCakeChat,
  onCreateCakeChat,
  onOpenSession,
  onCreateSession,
  onChooseProject,
  onToggle,
}: {
  store: SidebarStore;
  projects: ProjectCatalogStore;
  chat: ProjectWorkbenchStore;
  cakeChat: GlobalChatStore;
  shell: AppShellStore;
  onOpenSettings: () => void;
  onOpenCakeChat(sessionId?: string): void;
  onCreateCakeChat(): void;
  onOpenSession(sessionId: string): void;
  onCreateSession(workspacePath: string): void;
  onChooseProject(): void;
  onToggle: () => void;
}) {
  const projectPaths = projects.orderedProjectPaths;
  return (
    <aside className="sidebar">
      <div className="sidebar-window-tools">
        <IconButton tooltip="Toggle sidebar" onClick={onToggle}>
          <SidebarIcon />
        </IconButton>
        <IconButton tooltip="Back" disabled>
          <BackIcon />
        </IconButton>
        <IconButton tooltip="Forward" disabled>
          <ForwardIcon />
        </IconButton>
      </div>
      <div className="plugin-slot plugin-slot-sidebar-header">
        <Slot name="global.sidebar.header" />
      </div>
      <div className="sidebar-scroll">
        <SidebarCakeChatGroup
          store={store}
          cakeChat={cakeChat}
          shell={shell}
          resolved={false}
          onOpenCakeChat={onOpenCakeChat}
          onCreateCakeChat={onCreateCakeChat}
        />
        <div className="section-heading projects-heading">
          <span>Projects</span>
          <div>
            <IconButton tooltip="Add project" onClick={onChooseProject}>
              <PlusIcon />
            </IconButton>
          </div>
        </div>
        {projectPaths.length === 0 ? (
          <p className="sidebar-empty">Add a folder to start a project.</p>
        ) : (
          projectPaths.map((path) => (
            <SidebarProjectGroup
              key={path}
              store={store}
              projects={projects}
              chat={chat}
              shell={shell}
              path={path}
              resolved={false}
              onCreateSession={onCreateSession}
              onOpenSession={onOpenSession}
            />
          ))
        )}
        {store.hasResolvedSessions && (
          <section className="resolved-lane" aria-labelledby="resolved-lane-heading">
            <div className="section-heading lane-heading" id="resolved-lane-heading">
              <button
                className="lane-toggle"
                type="button"
                aria-expanded={store.resolvedLaneExpanded}
                aria-controls="resolved-lane-content"
                aria-label={`${store.resolvedLaneExpanded ? "Collapse" : "Expand"} Resolved`}
                onClick={() => store.toggleResolvedLane()}
              >
                <span
                  className={`lane-disclosure ${store.resolvedLaneExpanded ? "" : "collapsed"}`}
                >
                  <ChevronIcon />
                </span>
                <span>Resolved</span>
              </button>
            </div>
            {store.resolvedLaneExpanded && (
              <div id="resolved-lane-content" className="resolved-lane-content">
                <SidebarCakeChatGroup
                  store={store}
                  cakeChat={cakeChat}
                  shell={shell}
                  resolved
                  onOpenCakeChat={onOpenCakeChat}
                  onCreateCakeChat={onCreateCakeChat}
                />
                {projectPaths.map((path) => (
                  <SidebarProjectGroup
                    key={`resolved:${path}`}
                    store={store}
                    projects={projects}
                    chat={chat}
                    shell={shell}
                    path={path}
                    resolved
                    onCreateSession={onCreateSession}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="plugin-slot plugin-slot-sidebar-footer">
          <Slot name="global.sidebar.footer" />
        </div>
        <IconButton
          className={
            shell.selection.kind === "settings"
              ? "sidebar-settings-icon active"
              : "sidebar-settings-icon"
          }
          tooltip="Open settings"
          aria-current={shell.selection.kind === "settings" ? "page" : undefined}
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </IconButton>
      </div>
    </aside>
  );
});
