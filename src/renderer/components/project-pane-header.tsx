import { observer, useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import {
  BrowserIcon,
  ChangesIcon,
  TerminalIcon,
  TreeIcon,
  VsCodeIcon,
} from "@/components/ui/icons";
import { WorkLogControls } from "@/components/work-log-controls";
import { SideChatsMenu } from "@/components/side-chats-menu";
import { RootStore } from "../stores/RootStore";
import type { SessionPaneNode } from "../stores/SessionLayoutStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { SessionArtifactMenu } from "./session-artifact-menu";
import { ConversationActivity } from "./conversation-activity";

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
  const focusPane = () => root.navigationStore.focusSessionPane(pane.paneId);
  const focused = root.sessionLayoutStore.focusedPaneId === pane.paneId;
  const resolved = root.sessionCatalogStore.find(paneSession.sessionId)?.resolved === true;
  if (paneSession.isForkPreview) return null;
  if (resolved)
    return (
      <>
        {!paneSession.conversationSessionStore.chatStore.composerVisible && (
          <ConversationActivity
            sessionId={paneSession.sessionId}
            subagents={paneSession.subagentActivityStore}
            sideChat={paneSession.conversationSessionStore.sideChatStore}
            onOpen={focusPane}
          />
        )}
        <SideChatsMenu store={paneSession} onOpen={focusPane} />
        <SessionArtifactMenu session={paneSession} onOpen={focusPane} />
      </>
    );
  return (
    <>
      {!paneSession.conversationSessionStore.chatStore.composerVisible && (
        <ConversationActivity
          sessionId={paneSession.sessionId}
          subagents={paneSession.subagentActivityStore}
          sideChat={paneSession.conversationSessionStore.sideChatStore}
          onOpen={focusPane}
        />
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
      <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60 phone:hidden" aria-hidden="true" />
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
        className="phone:hidden"
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
          className="phone:hidden"
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
        className="phone:hidden"
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
      <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60 phone:hidden" aria-hidden="true" />
    </>
  );
});
