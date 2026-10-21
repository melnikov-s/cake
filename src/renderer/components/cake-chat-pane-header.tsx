import { observer, useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import {
  BrowserIcon,
  CheckIcon,
  VsCodeIcon,
  CloseIcon,
  CropIcon,
  SidebarIcon,
  TerminalIcon,
} from "@/components/ui/icons";
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
            "absolute left-[84px] top-[9px] max-[620px]:left-2 phone:left-2 [@media(pointer:coarse)]:top-1 z-20 size-7 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
            sidebarCollapsed ? "grid" : "hidden max-[620px]:grid phone:grid",
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
      {!paneSession.conversationSessionStore.chatStore.composerVisible && (
        <ConversationActivity
          sessionId={paneSession.sessionId}
          subagents={paneSession.subagentActivityStore}
          sideChat={paneSession.conversationSessionStore.sideChatStore}
          onOpen={() => root.navigationStore.focusCakeChatPane(pane.paneId)}
        />
      )}
      {!overlay && (
        <SessionArtifactMenu
          session={paneSession}
          onOpen={() => root.navigationStore.focusCakeChatPane(pane.paneId)}
        />
      )}
      {paneSession.todos.project && !overlay && (
        <IconButton
          tooltip="To-do"
          pressedAppearance="subtle"
          className="flex h-8 w-auto gap-1.5 px-2 aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:hover:bg-muted"
          aria-pressed={paneSession.todos.visible}
          onClick={() => {
            root.navigationStore.focusCakeChatPane(pane.paneId);
            paneSession.todos.toggle();
          }}
        >
          <CheckIcon />
          <span className="font-mono text-[11px] tabular-nums">
            {paneSession.todos.openItems.length}
          </span>
        </IconButton>
      )}
      <SideChatsMenu
        store={paneSession}
        onOpen={() => root.navigationStore.focusCakeChatPane(pane.paneId)}
      />
      {!overlay && (
        <>
          <IconButton
            tooltip="Open Browser Mode"
            hotkey="toggle-browser"
            onClick={() => {
              root.navigationStore.focusCakeChatPane(pane.paneId);
              void root.projectWorkbenchStore.presentationStore.openBrowser();
            }}
          >
            <BrowserIcon />
          </IconButton>
          {cakeChatCollection.summaries.some(
            (chat) => chat.sessionId === paneSession.sessionId && chat.projectPath,
          ) && (
            <IconButton
              tooltip="Open VS Code"
              hotkey="open-editor"
              className="phone:hidden"
              onClick={() => {
                root.navigationStore.focusCakeChatPane(pane.paneId);
                void root.projectWorkbenchStore.presentationStore.openIde();
              }}
            >
              <VsCodeIcon />
            </IconButton>
          )}
          <WorkLogControls store={paneSession.conversationSessionStore.chatStore} />
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
          className="phone:hidden"
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
