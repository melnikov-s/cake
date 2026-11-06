import { observer, useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { NumberedIconButton } from "@/components/ui/numbered-icon-button";
import { cn } from "../lib/utils";
import {
  BrowserIcon,
  CheckIcon,
  VsCodeIcon,
  CloseIcon,
  CameraIcon,
  TerminalIcon,
} from "@/components/ui/icons";
import { ToolbarGroup } from "@/components/ui/toolbar-group";
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
  return (
    <>
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
      {paneSession.todos.available && !overlay && (
        <NumberedIconButton
          tooltip="To-do"
          count={paneSession.todos.openItems.length}
          aria-description={`${paneSession.todos.openItems.length} open to-dos`}
          pressedAppearance="subtle"
          viewFocused={paneSession.todos.focusedItems.length > 0}
          className={cn(
            paneSession.todos.focusedItems.length === 0 &&
              "aria-pressed:bg-muted aria-pressed:text-foreground aria-pressed:hover:bg-muted",
          )}
          aria-pressed={paneSession.todos.visible}
          onClick={() => {
            root.navigationStore.focusCakeChatPane(pane.paneId);
            paneSession.todos.toggle();
          }}
        >
          <CheckIcon />
        </NumberedIconButton>
      )}
      <SideChatsMenu
        store={paneSession}
        onOpen={() => root.navigationStore.focusCakeChatPane(pane.paneId)}
      />
      {overlay ? (
        <>
          <IconButton
            tooltip="Take screenshot"
            disabled={overlay.capturing}
            onClick={overlay.onCaptureScreenshot}
          >
            <CameraIcon />
          </IconButton>
          <IconButton tooltip="Close drop-down Cake Chat" onClick={overlay.onClose}>
            <CloseIcon />
          </IconButton>
        </>
      ) : (
        <ToolbarGroup label="Workspace tools">
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
        </ToolbarGroup>
      )}
    </>
  );
});
