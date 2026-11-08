import { observer, useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon, CameraIcon } from "@/components/ui/icons";
import { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { SessionArtifactMenu } from "./session-artifact-menu";
import { SideChatsMenu } from "./side-chats-menu";
import { ConversationActivity } from "./conversation-activity";
import { WorkspaceModeControls } from "./workspace-mode-controls";
import { WorkLogControls } from "./work-log-controls";

export interface CakeChatOverlayChrome {
  /** Puts the drop-down overlay away. */
  onClose(): void;
  /** Captures a screen region or display into the Cake Chat draft. */
  onCaptureScreenshot(): void;
  capturing: boolean;
}

export const CakeChatPaneHeader = observer(function CakeChatPaneHeader({
  session: paneSession,
  overlay,
}: {
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
        />
      )}
      {!overlay && <SessionArtifactMenu session={paneSession} />}
      <SideChatsMenu store={paneSession} />
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
        <>
          <WorkspaceModeControls
            mode="normal"
            terminalAvailable={terminal.available}
            terminalOpen={paneSession.sessionId === cakeChatCollection.sessionId && terminal.open}
            ideAvailable={cakeChatCollection.summaries.some(
              (chat) => chat.sessionId === paneSession.sessionId && chat.projectPath,
            )}
            onBackToAgent={() => void root.projectWorkbenchStore.presentationStore.backToAgent()}
            onOpenBrowser={() => void root.projectWorkbenchStore.presentationStore.openBrowser()}
            onOpenIde={() => void root.projectWorkbenchStore.presentationStore.openIde()}
            onToggleTerminal={() => void terminal.toggle()}
          />
          <WorkLogControls store={paneSession.conversationSessionStore.chatStore} />
        </>
      )}
    </>
  );
});
