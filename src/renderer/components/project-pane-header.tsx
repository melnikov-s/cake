import { observer, useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import {
  BrowserIcon,
  ChangesIcon,
  SidebarIcon,
  TerminalIcon,
  TreeIcon,
  VsCodeIcon,
  WhiteboardIcon,
} from "@/components/ui/icons";
import { WorkLogControls } from "@/components/work-log-controls";
import { SideChatsMenu } from "@/components/side-chats-menu";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";
import type { SessionPaneNode } from "../stores/SessionLayoutStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { SessionArtifactMenu } from "./session-artifact-menu";

export const ProjectPaneHeader = observer(function ProjectPaneHeader({
  pane,
  session: paneSession,
  browserMode,
}: {
  pane: SessionPaneNode;
  session: ProjectSessionStore;
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const terminal = root.terminalStore;
  const sidebarCollapsed = !root.sidebarStore.visible;
  const toggleSidebar = () => root.sidebarStore.toggle();
  const focusPane = () => root.navigationStore.focusSessionPane(pane.paneId);
  const focused = root.sessionLayoutStore.focusedPaneId === pane.paneId;
  const firstPane = root.sessionLayoutStore.panes[0]?.paneId === pane.paneId;
  const resolved = root.sessionCatalogStore.find(paneSession.sessionId)?.resolved === true;
  if (resolved)
    return (
      <>
        {firstPane && (
          <IconButton
            className={cn(
              "absolute left-[84px] top-[9px] z-20 size-7 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
              sidebarCollapsed ? "grid" : "hidden max-[620px]:grid",
            )}
            data-slot="header-sidebar-toggle"
            tooltip="Toggle sidebar"
            hotkey="toggle-sidebar"
            onClick={toggleSidebar}
          >
            <SidebarIcon />
          </IconButton>
        )}
        <SideChatsMenu store={paneSession} onOpen={focusPane} />
        <SessionArtifactMenu session={paneSession} onOpen={focusPane} />
      </>
    );
  return (
    <>
      {firstPane && (
        <IconButton
          className={cn(
            "absolute left-[84px] top-[9px] z-20 size-7 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            sidebarCollapsed ? "grid" : "hidden max-[620px]:grid",
          )}
          data-slot="header-sidebar-toggle"
          data-cake-hint-key="s"
          tooltip="Toggle sidebar"
          hotkey="toggle-sidebar"
          onClick={toggleSidebar}
        >
          <SidebarIcon />
        </IconButton>
      )}
      <IconButton
        data-cake-hint-key="r"
        tooltip="Session tree"
        hotkey="toggle-session-tree"
        aria-pressed={focused && store.commandPaneStore.pane === "tree"}
        onClick={() => {
          focusPane();
          store.commandPaneStore.toggle("tree");
        }}
      >
        <TreeIcon />
      </IconButton>
      <SideChatsMenu store={paneSession} onOpen={focusPane} />
      <SessionArtifactMenu session={paneSession} onOpen={focusPane} />
      <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />
      <WorkLogControls store={paneSession.conversationSessionStore.chatStore} />
      <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />
      <IconButton
        tooltip="Open Cake Draw"
        onClick={() => {
          focusPane();
          void store.presentationStore.openDraw();
        }}
      >
        <WhiteboardIcon />
      </IconButton>
      {!browserMode && (
        <IconButton
          tooltip="Open Browser Mode"
          hotkey="toggle-browser"
          onClick={() => {
            focusPane();
            void store.presentationStore.openBrowser();
          }}
        >
          <BrowserIcon />
        </IconButton>
      )}
      <IconButton
        data-cake-hint-key="v"
        tooltip="Open VS Code"
        hotkey="open-editor"
        onClick={() => {
          focusPane();
          void store.presentationStore.openIde();
        }}
      >
        <VsCodeIcon />
      </IconButton>
      {!store.sessionRegistry.pendingSessions.isTemporary(paneSession.sessionId) && (
        <IconButton
          data-cake-hint-key="d"
          tooltip="Open workspace changes in VS Code"
          hotkey="open-changes"
          onClick={() => {
            focusPane();
            void store.presentationStore.openWorkspaceChanges();
          }}
        >
          <ChangesIcon />
        </IconButton>
      )}
      <IconButton
        data-cake-hint-key="t"
        tooltip="Terminal"
        hotkey="toggle-terminal"
        disabled={!terminal.available}
        aria-pressed={focused && terminal.open}
        onClick={() => {
          focusPane();
          void terminal.toggle();
        }}
      >
        <TerminalIcon />
      </IconButton>
      <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />
    </>
  );
});
