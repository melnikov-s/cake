import { observer, useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon, CropIcon, SidebarIcon, TerminalIcon } from "@/components/ui/icons";
import { RequestInspector } from "@/components/request-inspector";
import { WorkLogControls } from "@/components/work-log-controls";
import { cn } from "@/lib/utils";
import { RootStore } from "../stores/RootStore";
import type { SessionPaneNode } from "../stores/SessionLayoutStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { SessionArtifactMenu } from "./session-artifact-menu";
import { SideChatsMenu } from "./side-chats-menu";
import { ConversationActivity } from "./conversation-activity";

export interface CakeChatOverlayChrome {
  /** Puts the drop-down overlay away. */
  onClose(): void;
  /** Captures a screen region or display into the Cake Chat draft. */
  onCaptureScreenshot(): void;
  capturing: boolean;
}

export const CakeChatPaneHeader = observer(function CakeChatPaneHeader({
  pane,
  session: paneSession,
  overlay,
}: {
  pane: SessionPaneNode;
  session: CakeChatSessionStore;
  overlay?: CakeChatOverlayChrome;
}) {
  const root = useStore(RootStore);
  const cakeChatCollection = root.cakeChatCollectionStore;
  const terminal = root.terminalStore;
  const sidebarCollapsed = !root.sidebarStore.visible;
  const toggleSidebar = () => root.sidebarStore.toggle();
  const firstPane = cakeChatCollection.sessionLayoutStore.panes[0]?.paneId === pane.paneId;
  return (
    <>
      {firstPane && !overlay && (
        <IconButton
          className={cn(
            "absolute left-[84px] top-[9px] max-[620px]:left-2 [@media(pointer:coarse)]:top-1 z-20 size-7 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
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
      <ConversationActivity
        sessionId={paneSession.sessionId}
        subagents={paneSession.subagentActivityStore}
        sideChat={paneSession.conversationSessionStore.sideChatStore}
        onOpen={() => root.navigationStore.focusCakeChatPane(pane.paneId)}
      />
      {!overlay && (
        <SessionArtifactMenu
          session={paneSession}
          onOpen={() => root.navigationStore.focusCakeChatPane(pane.paneId)}
        />
      )}
      <SideChatsMenu
        store={paneSession}
        onOpen={() => root.navigationStore.focusCakeChatPane(pane.paneId)}
      />
      {!overlay && (
        <>
          <WorkLogControls store={paneSession.conversationSessionStore.chatStore} />
          <RequestInspector store={paneSession.requestInspectorStore} />
        </>
      )}
      {overlay ? (
        <>
          <IconButton
            tooltip="Capture screenshot"
            disabled={overlay.capturing}
            onClick={overlay.onCaptureScreenshot}
          >
            <CropIcon />
          </IconButton>
          <IconButton tooltip="Close drop-down Cake Chat" onClick={overlay.onClose}>
            <CloseIcon />
          </IconButton>
        </>
      ) : (
        <IconButton
          data-cake-hint-key="t"
          tooltip="Terminal"
          hotkey="toggle-terminal"
          disabled={!terminal.available}
          aria-pressed={paneSession.sessionId === cakeChatCollection.sessionId && terminal.open}
          onClick={() => {
            root.navigationStore.focusCakeChatPane(pane.paneId);
            void terminal.toggle();
          }}
        >
          <TerminalIcon />
        </IconButton>
      )}
    </>
  );
});
