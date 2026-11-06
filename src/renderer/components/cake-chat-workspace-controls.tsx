import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { WorkspaceModeControls } from "./workspace-mode-controls";
import { SideChatsMenu } from "./side-chats-menu";
import { SessionArtifactMenu } from "./session-artifact-menu";
import { ConversationActivity } from "./conversation-activity";
import { WorkspaceTodosToggle } from "./workspace-todos-toggle";

export const CakeChatWorkspaceControls = observer(function CakeChatWorkspaceControls({
  session,
  mode,
  browserMode,
}: {
  session: CakeChatSessionStore;
  mode: "browser" | "vscode";
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const presentation = root.projectWorkbenchStore.presentationStore;
  const terminal = root.terminalStore;
  return (
    <>
      {!session.conversationSessionStore.chatStore.composerVisible && (
        <ConversationActivity
          sessionId={session.sessionId}
          subagents={session.subagentActivityStore}
          sideChat={session.conversationSessionStore.sideChatStore}
          onOpen={() => session.showWorkspaceChatSidebar()}
        />
      )}
      <SessionArtifactMenu session={session} />
      <SideChatsMenu store={session} />
      <WorkspaceTodosToggle />
      <WorkspaceModeControls
        chatSidebarVisible={session.workspaceChatSidebarVisible}
        onToggleChatSidebar={() => session.toggleWorkspaceChatSidebar()}
        mode={mode}
        terminalAvailable={terminal.available}
        terminalOpen={terminal.open}
        browserHost={browserMode}
        ideAvailable={Boolean(root.workspaceProjectPath)}
        onBackToAgent={() => void presentation.backToAgent()}
        onOpenBrowser={() => void presentation.openBrowser()}
        onOpenIde={() => void presentation.openIde()}
        onToggleTerminal={() => void terminal.toggle()}
      />
    </>
  );
});
