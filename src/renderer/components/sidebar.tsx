import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { IconButton } from "./ui/icon-button";
import { BackIcon, FolderPlusIcon, ForwardIcon, SettingsIcon, SidebarIcon } from "./ui/icons";
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
  onRemoveProject,
  onChooseProject,
  onGoBack,
  onGoForward,
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
  onRemoveProject(path: string, deleteSessions: boolean): Promise<boolean>;
  onChooseProject(): void;
  onGoBack(): void;
  onGoForward(): void;
  onToggle: () => void;
}) {
  const projectPaths = projects.orderedProjectPaths;
  return (
    <aside
      data-slot="sidebar"
      className="flex h-full min-w-0 flex-col overflow-hidden border-r border-border/72 bg-sidebar select-none"
    >
      <div className="flex h-[46px] shrink-0 items-center gap-1 pl-[103px] pr-3 [app-region:drag]">
        <IconButton tooltip="Toggle sidebar" onClick={onToggle}>
          <SidebarIcon />
        </IconButton>
        <IconButton
          tooltip="Back"
          disabled={!shell.canGoBack}
          onClick={onGoBack}
          ariaLabel="Go back in session history"
        >
          <BackIcon />
        </IconButton>
        <IconButton
          tooltip="Forward"
          disabled={!shell.canGoForward}
          onClick={onGoForward}
          ariaLabel="Go forward in session history"
        >
          <ForwardIcon />
        </IconButton>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5 px-3 pb-2 empty:hidden">
        <Slot name="global.sidebar.header" />
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-2">
        <SidebarCakeChatGroup
          store={store}
          cakeChat={cakeChat}
          shell={shell}
          resolved={false}
          onOpenCakeChat={onOpenCakeChat}
          onCreateCakeChat={onCreateCakeChat}
        />
        <div
          data-slot="projects-heading"
          className="mt-0.5 flex items-center justify-between px-1.5 py-2 text-xs font-medium text-muted-foreground"
        >
          <span>Projects</span>
          <div>
            <IconButton tooltip="Add project" onClick={onChooseProject}>
              <FolderPlusIcon />
            </IconButton>
          </div>
        </div>
        {projectPaths.length === 0 ? (
          <p className="mx-2 my-1.5 text-xs leading-relaxed text-muted-foreground">
            Add a folder to start a project.
          </p>
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
              onRemoveProject={onRemoveProject}
            />
          ))
        )}
        <section
          data-slot="resolved-lane"
          className="mt-4 border-t border-border/72 pt-2"
          aria-label="Resolved sessions"
        >
          <div
            className="flex items-center justify-between px-1.5 pt-2.5 text-xs font-medium text-muted-foreground"
            id="resolved-lane-heading"
          >
            <DisclosureTrigger
              className="h-[27px] px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              open={store.resolvedLaneExpanded}
              aria-controls="resolved-lane-content"
              aria-label={`${store.resolvedLaneExpanded ? "Collapse" : "Expand"} Resolved`}
              onClick={() => store.toggleResolvedLane()}
              title="Resolved"
            />
          </div>
          {store.resolvedLaneExpanded && (
            <div id="resolved-lane-content" className="mt-1">
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
                  onRemoveProject={onRemoveProject}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="flex min-h-[52px] items-center justify-end border-t border-border/65 px-4 py-2 text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 empty:hidden">
          <Slot name="global.sidebar.footer" />
        </div>
        <IconButton
          className={cn(
            "size-8 rounded-lg bg-transparent text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
            shell.selection.kind === "settings" && "bg-sidebar-hover text-foreground",
          )}
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
