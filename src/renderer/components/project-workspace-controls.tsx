import { observer, useStore } from "r-state-tree/react";
import { WorkspaceModeControls } from "@/components/workspace-mode-controls";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { SessionArtifactMenu } from "./session-artifact-menu";
import { ConversationActivity } from "./conversation-activity";
import { WorkspaceTodosToggle } from "./workspace-todos-toggle";
import { SessionChangesToggle } from "./session-changes-toggle";
import { SideChatsMenu } from "./side-chats-menu";

export const ProjectWorkspaceControls = observer(function ProjectWorkspaceControls({
  session,
  mode,
  browserMode,
}: {
  session: ProjectSessionStore;
  mode: Exclude<ProjectSessionStore["presentationMode"], "normal">;
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
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
      <SideChatsMenu store={session} onOpen={() => root.workspaceNavigatorStore.showChat()} />
      <SessionChangesToggle session={session} />
      <WorkspaceTodosToggle />
      <WorkspaceModeControls
        mode={mode}
        terminalAvailable={terminal.available}
        terminalOpen={terminal.open}
        browserHost={browserMode}
        onBackToAgent={() => void store.presentationStore.backToAgent()}
        onOpenBrowser={() => void store.presentationStore.openBrowser()}
        onOpenIde={() => void store.presentationStore.openIde()}
        onToggleTerminal={() => void terminal.toggle()}
      />
    </>
  );
});
