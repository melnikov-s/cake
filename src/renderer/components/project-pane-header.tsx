import { observer, useStore } from "r-state-tree/react";
import { SideChatsMenu } from "@/components/side-chats-menu";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { SessionArtifactMenu } from "./session-artifact-menu";
import { SessionChangesToggle } from "./session-changes-toggle";
import { ConversationActivity } from "./conversation-activity";
import { WorkspaceModeControls } from "./workspace-mode-controls";
import { WorkspaceTodosToggle } from "./workspace-todos-toggle";

export const ProjectPaneHeader = observer(function ProjectPaneHeader({
  session: paneSession,
  browserMode,
}: {
  session: ProjectSessionStore;
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const presentation = root.projectWorkbenchStore.presentationStore;
  const terminal = root.terminalStore;
  const resolved = root.sessionCatalogStore.find(paneSession.sessionId)?.resolved === true;
  if (paneSession.isForkPreview) return null;
  return (
    <>
      {!paneSession.conversationSessionStore.chatStore.composerVisible && (
        <ConversationActivity
          sessionId={paneSession.sessionId}
          subagents={paneSession.subagentActivityStore}
          sideChat={paneSession.conversationSessionStore.sideChatStore}
        />
      )}
      <SessionArtifactMenu session={paneSession} />
      <SideChatsMenu store={paneSession} />
      <WorkspaceTodosToggle />
      {!resolved && (
        <>
          <SessionChangesToggle session={paneSession} />
          <WorkspaceModeControls
            mode="normal"
            terminalAvailable={terminal.available}
            terminalOpen={terminal.open}
            browserHost={browserMode}
            onBackToAgent={() => void presentation.backToAgent()}
            onOpenBrowser={() => void presentation.openBrowser()}
            onOpenIde={() => void presentation.openIde()}
            onToggleTerminal={() => void terminal.toggle()}
          />
        </>
      )}
    </>
  );
});
