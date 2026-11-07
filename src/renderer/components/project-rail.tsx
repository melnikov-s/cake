import { useCallback, useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { cn } from "../lib/utils";
import { describeError } from "../lib/error-details";
import { Avatar } from "./ui/avatar";
import { IconButton } from "./ui/icon-button";
import {
  CakeIcon,
  FolderPlusIcon,
  LightningIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
} from "./ui/icons";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import { ArtifactCatalogMenu } from "./artifact-catalog-menu";
import { BrowserSharingMenu } from "./browser-sharing-menu";
import { SortableItem } from "./ui/sortable-item";
import { NavigationRail } from "./ui/navigation-rail";
import { StatusDot } from "./ui/status-dot";
import { ProjectActionDialog, type ProjectAction } from "./project-action-dialog";
import { SessionSearchDialog } from "./session-search-dialog";

/** Persistent project homes and global actions; never a second session list. */
export const ProjectRail = observer(function ProjectRail() {
  const root = useStore(RootStore);
  const projects = root.projectCatalogStore;
  const navigator = root.workspaceNavigatorStore;
  const [action, setAction] = useState<{ path: string; kind: ProjectAction }>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const projectMenu = async (path: string, x: number, y: number) => {
    const selected = await root.sidebarStore.showProjectContextMenu(path, x, y);
    if (selected === "settings") root.projectSettingsStore.open(path);
    else if (selected === "remove-project" || selected === "delete-resolved-worktrees") {
      setActionError(undefined);
      setAction({ path, kind: selected });
    }
  };
  const activeProject = root.workspaceProjectPath;
  const runningProjects = new Set(
    projects.orderedProjectPaths.filter((path) =>
      root.conversationNavigatorStore.projectRunning(path),
    ),
  );
  const setOverlayRight = useCallback(
    (right: number) => root.projectRailStore.setOverlayRight(right),
    [root],
  );
  return (
    <>
      <NavigationRail
        label="Projects and global utilities"
        onOverlayRightChange={setOverlayRight}
        header={
          <>
            <IconButton
              tooltip="Cake Chat"
              label="Cake Chat"
              ariaLabel="Open Cake Chat"
              className={cn(
                "h-9 shrink-0",
                !activeProject &&
                  root.appShellStore.surface === "cake-chat" &&
                  "bg-sidebar-active text-foreground",
              )}
              onClick={() => {
                root.appShellStore.recordConversationInteraction({
                  kind: "cake-chat",
                  sessionId: CAKE_CHAT_SESSION_ID,
                });
                void root.navigationStore.openCakeChat();
              }}
            >
              <CakeIcon />
            </IconButton>
            <IconButton
              tooltip="Add project"
              label="Add project"
              className="h-9 shrink-0"
              onClick={() => void root.navigationStore.chooseProject()}
            >
              <FolderPlusIcon />
            </IconButton>
          </>
        }
        footer={
          <>
            <IconButton
              tooltip={navigator.visible ? "Close Workspace" : "Open Workspace"}
              label={navigator.visible ? "Close Workspace" : "Open Workspace"}
              ariaLabel={navigator.visible ? "Close Workspace" : "Open Workspace"}
              hotkey="toggle-sidebar"
              aria-pressed={navigator.visible}
              data-cake-hint-key="s"
              className="h-9 shrink-0 aria-pressed:bg-sidebar-active aria-pressed:text-foreground aria-pressed:shadow-none aria-pressed:hover:bg-sidebar-hover"
              onClick={() => navigator.toggle()}
            >
              <SidebarIcon />
            </IconButton>
            <IconButton
              tooltip="Search sessions"
              label="Search sessions"
              className="h-9 shrink-0"
              onClick={() => root.sidebarStore.sessionSearchStore.show()}
            >
              <SearchIcon />
            </IconButton>
            {!root.props.browserHost && !root.desktopConnection?.remote && (
              <div className="w-full shrink-0">
                <BrowserSharingMenu rail />
              </div>
            )}
            <div className="w-full shrink-0">
              <ArtifactCatalogMenu
                railLabel="Artifacts"
                store={root.artifactLibraryStore}
                onOpenArtifact={(lineageId) =>
                  root.navigationStore.openArtifact(undefined, lineageId)
                }
                onOpenLibrary={() => root.navigationStore.showArtifactLibrary()}
              />
            </div>
            <IconButton
              tooltip="Automations"
              label="Automations"
              className="h-9 shrink-0"
              onClick={() => root.navigationStore.showAutomations()}
            >
              <LightningIcon />
            </IconButton>
            <IconButton
              tooltip="Settings"
              label="Settings"
              hotkey="open-settings"
              className="h-9 shrink-0"
              onClick={() => root.navigationStore.showSettings()}
            >
              <SettingsIcon />
            </IconButton>
          </>
        }
      >
        <div className="flex w-full min-w-0 flex-col gap-1">
          {projects.orderedProjectPaths.map((path) => (
            <SortableItem
              key={path}
              id={path}
              className="w-full shrink-0"
              onMove={(source, target, placement) => projects.move(source, target, placement)}
            >
              {(dragHandleProps) => (
                <IconButton
                  {...dragHandleProps}
                  tooltip={projects.nameForPath(path)}
                  label={projects.nameForPath(path)}
                  ariaLabel={`Open Project Chat for ${projects.nameForPath(path)}`}
                  className={cn(
                    "h-9 shrink-0",
                    activeProject === path && "bg-sidebar-active text-foreground",
                  )}
                  aria-current={activeProject === path ? "page" : undefined}
                  aria-keyshortcuts="Shift+F10"
                  onClick={() => {
                    const home = root.cakeChatCollectionStore.projectChat(path);
                    if (home)
                      root.appShellStore.recordConversationInteraction({
                        kind: "cake-chat",
                        sessionId: home.sessionId,
                      });
                    void root.navigationStore.openProjectChat(path);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void projectMenu(path, event.clientX, event.clientY);
                  }}
                  onKeyDown={(event) => {
                    if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      void projectMenu(path, rect.right, rect.top);
                    }
                  }}
                >
                  <span className="relative grid size-9 place-items-center">
                    <Avatar
                      kind="project"
                      className="size-[32.5px]"
                      seed={projects.nameForPath(path)}
                      customIcon={projects.find(path)?.settings?.icon}
                      title={projects.nameForPath(path)}
                      aria-hidden="true"
                    />
                    {runningProjects.has(path) && (
                      <StatusDot
                        status="running"
                        size="sm"
                        role="img"
                        aria-hidden={false}
                        aria-label={`Work running in ${projects.nameForPath(path)}`}
                        className="absolute bottom-0.5 right-0.5 ring-2 ring-sidebar"
                      />
                    )}
                  </span>
                </IconButton>
              )}
            </SortableItem>
          ))}
        </div>
      </NavigationRail>
      <ProjectSettingsDialog store={root.projectSettingsStore} />
      <SessionSearchDialog
        sidebar={root.sidebarStore}
        sessionMetadata={root.sessionMetadataStore}
        projects={projects}
        appearance={root.settingsStore.appearance}
        onOpenSession={(sessionId) => {
          root.appShellStore.recordConversationInteraction({ kind: "project-session", sessionId });
          void root.navigationStore.openSession(sessionId);
        }}
      />
      {action && (
        <ProjectActionDialog
          action={action.kind}
          projectName={projects.nameForPath(action.path)}
          sessionCount={root.sidebarStore.projectSessionCount(action.path)}
          resolvedWorktreeCount={root.sidebarStore.resolvedWorktreeCount(action.path)}
          busy={busy}
          error={actionError}
          onCancel={() => setAction(undefined)}
          onRemove={(deleteSessions) => {
            setActionError(undefined);
            setBusy(true);
            void root.projectRemovalStore
              .remove(action.path, deleteSessions)
              .then((removed) => {
                if (removed) setAction(undefined);
              })
              .catch((error: unknown) => setActionError(describeError(error).message))
              .finally(() => setBusy(false));
          }}
          onDeleteResolvedWorktrees={() => {
            setBusy(true);
            void root.projectWorkbenchStore
              .deleteResolvedWorktrees(action.path)
              .then(() => setAction(undefined))
              .finally(() => setBusy(false));
          }}
        />
      )}
    </>
  );
});
