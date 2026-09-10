import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { IconButton } from "./ui/icon-button";
import { BackIcon, FolderPlusIcon, ForwardIcon, SettingsIcon, SidebarIcon } from "./ui/icons";
import { SidebarCakeChatGroup } from "./sidebar-cake-chat-group";
import { SidebarProjectGroup } from "./sidebar-project-group";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { ProjectCatalogStore } from "../stores/ProjectCatalogStore";
import type { SidebarStore } from "../stores/SidebarStore";
import type { CakeChatCollectionStore } from "../stores/CakeChatCollectionStore";
import type { AppShellStore } from "../stores/AppShellStore";
import type { ProjectSettingsStore } from "../stores/ProjectSettingsStore";
import type { AppearanceSettingsStore } from "../stores/AppearanceSettingsStore";

export const Sidebar = observer(function Sidebar({
  store,
  projects,
  chat,
  cakeChat,
  shell,
  projectSettings,
  appearance,
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
  cakeChat: CakeChatCollectionStore;
  shell: AppShellStore;
  projectSettings: ProjectSettingsStore;
  appearance: AppearanceSettingsStore;
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
  const focusedProjectPath = store.focusModeProjectPath;
  const projectPaths = focusedProjectPath ? [focusedProjectPath] : projects.orderedProjectPaths;
  const focusMode = focusedProjectPath !== undefined;
  return (
    <aside
      data-slot="sidebar"
      data-focus-mode={focusMode ? "true" : undefined}
      className={cn(
        "flex h-full min-w-0 flex-col overflow-hidden border-r border-border/72 bg-sidebar select-none",
        focusMode && "[&_svg]:size-5",
      )}
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
      <div className="flex min-w-0 flex-wrap gap-1.5 px-3 pb-2 empty:hidden"></div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pb-4 pt-2">
        {!focusMode && (
          <>
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
              className="mt-0.5 flex items-center justify-between px-1.5 py-2 text-[13px] font-medium text-muted-foreground"
            >
              <span>Projects</span>
              <div>
                <IconButton tooltip="Add project" onClick={onChooseProject}>
                  <FolderPlusIcon />
                </IconButton>
              </div>
            </div>
          </>
        )}
        {projectPaths.length === 0 ? (
          <p className="mx-2 my-1.5 text-[13px] leading-relaxed text-muted-foreground">
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
              appearance={appearance}
              path={path}
              resolved={false}
              focusMode={focusMode}
              onToggleFocus={(path) =>
                focusMode ? store.leaveProjectFocus() : store.focusProject(path)
              }
              onCreateSession={onCreateSession}
              onOpenSession={onOpenSession}
              onRemoveProject={onRemoveProject}
              onOpenSettings={(path) => projectSettings.open(path)}
            />
          ))
        )}
        <section
          data-slot="resolved-lane"
          className="mt-4 border-t border-border/72 pt-2"
          aria-label="Resolved sessions"
        >
          <div
            className={cn(
              "flex items-center justify-between px-1.5 pt-2.5 text-[13px] font-medium text-muted-foreground",
              focusMode && "text-sm",
            )}
            id="resolved-lane-heading"
          >
            <DisclosureTrigger
              className={cn(
                "h-[27px] px-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground",
                focusMode && "h-9 text-sm",
              )}
              open={store.resolvedLaneExpanded}
              aria-controls="resolved-lane-content"
              aria-label={`${store.resolvedLaneExpanded ? "Collapse" : "Expand"} Resolved`}
              onClick={() => store.toggleResolvedLane()}
              title="Resolved"
            />
          </div>
          {store.resolvedLaneExpanded && (
            <div id="resolved-lane-content" className="mt-1">
              {!focusMode && (
                <SidebarCakeChatGroup
                  store={store}
                  cakeChat={cakeChat}
                  shell={shell}
                  resolved
                  onOpenCakeChat={onOpenCakeChat}
                  onCreateCakeChat={onCreateCakeChat}
                />
              )}
              {projectPaths.map((path) => (
                <SidebarProjectGroup
                  key={`resolved:${path}`}
                  store={store}
                  projects={projects}
                  chat={chat}
                  shell={shell}
                  appearance={appearance}
                  path={path}
                  resolved
                  focusMode={focusMode}
                  onCreateSession={onCreateSession}
                  onOpenSession={onOpenSession}
                  onRemoveProject={onRemoveProject}
                  onOpenSettings={(path) => projectSettings.open(path)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
      {!focusMode && (
        <div className="min-h-[52px] border-t border-border/65 px-3 py-2 text-muted-foreground">
          <Button
            variant="ghost"
            className={cn(
              "h-9 w-full justify-start gap-2 px-2 text-[13px] font-medium text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
              shell.selection.kind === "settings" && "bg-sidebar-hover text-foreground",
            )}
            aria-label="Open settings"
            aria-current={shell.selection.kind === "settings" ? "page" : undefined}
            onClick={onOpenSettings}
          >
            <SettingsIcon />
            <span>Settings</span>
          </Button>
        </div>
      )}
      <ProjectSettingsDialog store={projectSettings} />
    </aside>
  );
});
