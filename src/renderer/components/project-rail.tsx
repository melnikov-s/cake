import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { cn } from "../lib/utils";
import { Avatar } from "./ui/avatar";
import { IconButton } from "./ui/icon-button";
import {
  CakeIcon,
  FolderPlusIcon,
  LightningIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
} from "./ui/icons";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import { ArtifactCatalogMenu } from "./artifact-catalog-menu";
import { BrowserSharingMenu } from "./browser-sharing-menu";
import { SortableItem } from "./ui/sortable-item";
import { ProjectActionDialog, type ProjectAction } from "./project-action-dialog";
import { SessionSearchDialog } from "./session-search-dialog";

/** Persistent project homes and global actions; never a second session list. */
export const ProjectRail = observer(function ProjectRail() {
  const root = useStore(RootStore);
  const projects = root.projectCatalogStore;
  const navigator = root.workspaceNavigatorStore;
  const [action, setAction] = useState<{ path: string; kind: ProjectAction }>();
  const [busy, setBusy] = useState(false);
  const projectMenu = async (path: string, x: number, y: number) => {
    const selected = await root.sidebarStore.showProjectContextMenu(path, x, y);
    if (selected === "settings") root.projectSettingsStore.open(path);
    else if (selected === "remove-project" || selected === "delete-resolved-worktrees")
      setAction({ path, kind: selected });
  };
  const activeProject = root.workspaceProjectPath;
  return (
    <nav
      aria-label="Projects and global utilities"
      data-slot="project-rail"
      className="flex h-full min-h-0 flex-col items-center gap-1.5 overflow-hidden border-r border-border/70 bg-sidebar px-2 pb-3 pt-title-bar text-sidebar-foreground select-none"
    >
      <IconButton
        tooltip="Cake Chat"
        ariaLabel="Open Cake Chat"
        className={cn(
          "size-9 shrink-0",
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
      <div className="my-1 h-px w-7 shrink-0 bg-border/70" />
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto">
        {projects.orderedProjectPaths.map((path) => (
          <SortableItem
            key={path}
            id={path}
            className="shrink-0"
            onMove={(source, target, placement) => projects.move(source, target, placement)}
          >
            {(dragHandleProps) => (
              <IconButton
                {...dragHandleProps}
                tooltip={projects.nameForPath(path)}
                ariaLabel={`Open Project Chat for ${projects.nameForPath(path)}`}
                className={cn(
                  "size-9 shrink-0",
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
                <Avatar
                  kind="project"
                  seed={projects.nameForPath(path)}
                  customIcon={projects.find(path)?.settings?.icon}
                  title={projects.nameForPath(path)}
                  aria-hidden="true"
                />
              </IconButton>
            )}
          </SortableItem>
        ))}
      </div>
      <IconButton
        tooltip={navigator.visible ? "Close Workspace" : "Open Workspace"}
        ariaLabel={navigator.visible ? "Close Workspace" : "Open Workspace"}
        hotkey="toggle-sidebar"
        aria-pressed={navigator.visible}
        data-cake-hint-key="s"
        className="size-9 shrink-0 aria-pressed:bg-sidebar-active aria-pressed:text-foreground aria-pressed:shadow-none aria-pressed:hover:bg-sidebar-hover"
        onClick={() => navigator.toggle()}
      >
        <SidebarIcon />
      </IconButton>
      <IconButton
        tooltip="New Session"
        hotkey="new-session"
        className="size-9 shrink-0"
        onClick={() => root.newSessionStore.show()}
      >
        <PlusIcon />
      </IconButton>
      <IconButton
        tooltip="Search sessions"
        className="size-9 shrink-0"
        onClick={() => root.sidebarStore.sessionSearchStore.show()}
      >
        <SearchIcon />
      </IconButton>
      <IconButton
        tooltip="Add project"
        className="size-9 shrink-0"
        onClick={() => void root.navigationStore.chooseProject()}
      >
        <FolderPlusIcon />
      </IconButton>
      {!root.props.browserHost && !root.desktopConnection?.remote && (
        <div className="flex size-9 shrink-0 items-center justify-center">
          <BrowserSharingMenu />
        </div>
      )}
      <div className="flex size-9 shrink-0 items-center justify-center">
        <ArtifactCatalogMenu
          store={root.artifactLibraryStore}
          onOpenArtifact={(lineageId) => root.navigationStore.openArtifact(undefined, lineageId)}
          onOpenLibrary={() => root.navigationStore.showArtifactLibrary()}
        />
      </div>
      <IconButton
        tooltip="Automations"
        className="size-9 shrink-0"
        onClick={() => root.navigationStore.showAutomations()}
      >
        <LightningIcon />
      </IconButton>
      <IconButton
        tooltip="Settings"
        hotkey="open-settings"
        className="size-9 shrink-0"
        onClick={() => root.navigationStore.showSettings()}
      >
        <SettingsIcon />
      </IconButton>
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
          onCancel={() => setAction(undefined)}
          onRemove={(deleteSessions) => {
            setBusy(true);
            void root.projectRemovalStore
              .remove(action.path, deleteSessions)
              .then((removed) => {
                if (removed) setAction(undefined);
              })
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
    </nav>
  );
});
