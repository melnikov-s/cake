import { useCallback, useLayoutEffect, useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { cn } from "../lib/utils";
import { describeError } from "../lib/error-details";
import { Avatar } from "./ui/avatar";
import { IconButton } from "./ui/icon-button";
import {
  ArtifactIcon,
  CakeIcon,
  LightningIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "./ui/icons";
import { AddProjectDialog } from "./add-project-dialog";
import { ProjectSettingsDialog } from "./project-settings-dialog";
import { BrowserSharingMenu } from "./browser-sharing-menu";
import { SortableItem } from "./ui/sortable-item";
import { NavigationRail } from "./ui/navigation-rail";
import { NavigationRailSection } from "./ui/navigation-rail-section";
import {
  AddProjectHeadingButton,
  AddProjectRow,
  defaultAddProjectPlacement,
  type AddProjectPlacement,
} from "./project-rail-add-project";
import { StatusDot } from "./ui/status-dot";
import { ProjectActionDialog, type ProjectAction } from "./project-action-dialog";
import { SessionSearchDialog } from "./session-search-dialog";

/**
 * Three visual levels: content rows (Cake Chat, projects) at full-strength text, quieter
 * grey actions, and compact utilities at the bottom. Only the selected row gains weight.
 */
const railRow = {
  content: "h-8 shrink-0 text-foreground aria-[current=page]:font-medium",
  action: "h-8 shrink-0",
  utility: "h-7 shrink-0",
} as const;

/** Persistent project homes and global actions; never a second session list. */
export const ProjectRail = observer(function ProjectRail({
  autoHide,
  addProjectPlacement = defaultAddProjectPlacement,
}: {
  autoHide?: boolean;
  addProjectPlacement?: AddProjectPlacement;
}) {
  const root = useStore(RootStore);
  const projects = root.projectCatalogStore;
  const preferences = root.settingsStore.appearance.leftToolbar.preferences;
  const hide = autoHide ?? preferences.autoHide;
  const [nativeMenuOpen, setNativeMenuOpen] = useState(false);
  useLayoutEffect(() => {
    root.projectRailStore.setRevealed(false);
    return () => root.projectRailStore.setRevealed(false);
  }, [root, hide, preferences.layout]);
  const [action, setAction] = useState<{ path: string; kind: ProjectAction }>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const projectMenu = async (path: string, x: number, y: number) => {
    setNativeMenuOpen(true);
    let selected;
    try {
      selected = await root.sidebarStore.showProjectContextMenu(path, x, y);
    } finally {
      setNativeMenuOpen(false);
    }
    if (selected === "settings") root.projectSettingsStore.open(path);
    else if (selected === "remove-project" || selected === "delete-resolved-worktrees") {
      setActionError(undefined);
      setAction({ path, kind: selected });
    }
  };
  const activeProject = root.workspaceProjectPath;
  const addProject = () => void root.navigationStore.chooseProject();
  const runningProjects = new Set(
    projects.orderedProjectPaths.filter((path) =>
      root.conversationNavigatorStore.projectRunning(path),
    ),
  );
  const unreadProjects = new Set(
    projects.orderedProjectPaths.filter((path) =>
      root.conversationNavigatorStore.projectUnread(path),
    ),
  );
  const errorProjects = new Set(
    projects.orderedProjectPaths.filter((path) =>
      root.sidebarStore.sessionListStore.projectHasError(path),
    ),
  );
  const setOverlayRight = useCallback(
    (right: number) => root.projectRailStore.setOverlayRight(right),
    [root],
  );
  const setRevealed = useCallback(
    (revealed: boolean) => root.projectRailStore.setRevealed(revealed),
    [root],
  );
  return (
    <>
      <NavigationRail
        label="Projects and global utilities"
        autoHide={hide}
        layout={preferences.layout}
        retained={nativeMenuOpen}
        revealed={root.projectRailStore.revealed}
        onRevealChange={setRevealed}
        onOverlayRightChange={setOverlayRight}
        header={
          <>
            <IconButton
              tooltip="Cake Chat"
              label="Cake Chat"
              ariaLabel="Open Cake Chat"
              className={cn(
                railRow.content,
                !activeProject &&
                  root.appShellStore.surface === "cake-chat" &&
                  "bg-sidebar-active text-foreground",
              )}
              aria-current={
                !activeProject && root.appShellStore.surface === "cake-chat" ? "page" : undefined
              }
              onClick={() => {
                root.appShellStore.recordConversationInteraction({
                  kind: "cake-chat",
                  sessionId: CAKE_CHAT_SESSION_ID,
                });
                void root.navigationStore.openGlobalChat();
              }}
            >
              <CakeIcon />
            </IconButton>
            <IconButton
              tooltip="New session"
              label="New session"
              hotkey="new-session"
              className={railRow.action}
              onClick={() => root.newSessionStore.show()}
            >
              <PlusIcon size={18} />
            </IconButton>
            <IconButton
              tooltip="Search sessions"
              label="Search sessions"
              className={railRow.action}
              onClick={() => root.sidebarStore.sessionSearchStore.show()}
            >
              <SearchIcon size={18} />
            </IconButton>
          </>
        }
        listHeading={
          <NavigationRailSection
            label="Projects"
            action={
              addProjectPlacement === "heading" ? (
                <AddProjectHeadingButton onAdd={addProject} />
              ) : undefined
            }
          />
        }
        footer={
          <>
            <IconButton
              tooltip="Artifacts"
              label="Artifacts"
              className={cn(
                railRow.utility,
                root.appShellStore.surface === "artifact-library" &&
                  "bg-sidebar-active text-foreground",
              )}
              aria-current={root.appShellStore.surface === "artifact-library" ? "page" : undefined}
              data-cake-hint-key="a"
              onClick={() => root.navigationStore.showArtifactLibrary()}
            >
              <ArtifactIcon size={18} />
            </IconButton>
            <IconButton
              tooltip="Automations"
              label="Automations"
              className={railRow.utility}
              onClick={() => root.navigationStore.showAutomations()}
            >
              <LightningIcon size={18} />
            </IconButton>
            <IconButton
              tooltip="Settings"
              label="Settings"
              hotkey="open-settings"
              className={railRow.utility}
              onClick={() => root.navigationStore.showSettings()}
            >
              <SettingsIcon size={18} />
            </IconButton>
            {!root.props.browserHost && !root.desktopConnection?.remote && (
              <div className="grid h-7 w-11 shrink-0 place-items-center">
                <BrowserSharingMenu rail />
              </div>
            )}
          </>
        }
      >
        <div className="flex w-full min-w-0 flex-col gap-0.5">
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
                    "relative",
                    railRow.content,
                    activeProject === path &&
                      "bg-[color-mix(in_oklab,var(--sidebar-active),var(--foreground)_8%)] text-foreground hover:bg-[color-mix(in_oklab,var(--sidebar-active),var(--foreground)_8%)] before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent",
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
                  <span className="relative grid size-6 place-items-center">
                    <Avatar
                      kind="project"
                      // Project artwork is not a control glyph; size it to sit level with line icons.
                      className="size-6"
                      seed={projects.nameForPath(path)}
                      customIcon={projects.find(path)?.settings?.icon}
                      title={projects.nameForPath(path)}
                      aria-hidden="true"
                    />
                    {!runningProjects.has(path) &&
                      (errorProjects.has(path) || unreadProjects.has(path)) && (
                        <StatusDot
                          status={errorProjects.has(path) ? "error" : "success"}
                          size="sm"
                          role="img"
                          aria-hidden={false}
                          aria-label={`${errorProjects.has(path) ? "Error" : "Unread sessions"} in ${projects.nameForPath(path)}`}
                          className="absolute -bottom-0.5 -left-0.5 ring-2 ring-sidebar"
                        />
                      )}
                    {runningProjects.has(path) && (
                      <StatusDot
                        status="running"
                        size="sm"
                        role="img"
                        aria-hidden={false}
                        aria-label={`Work running in ${projects.nameForPath(path)}`}
                        className="absolute -right-0.5 -bottom-0.5 ring-2 ring-sidebar"
                      />
                    )}
                  </span>
                </IconButton>
              )}
            </SortableItem>
          ))}
          {addProjectPlacement === "row" && (
            <AddProjectRow className={railRow.action} onAdd={addProject} />
          )}
        </div>
      </NavigationRail>
      <ProjectSettingsDialog store={root.projectSettingsStore} />
      <AddProjectDialog store={root.projectWorkbenchStore.projectOpenStore.setupStore} />
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
