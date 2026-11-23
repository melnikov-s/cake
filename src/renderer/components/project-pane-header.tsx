import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { SessionToolsGroup } from "./session-tools-group";
import { SessionArtifactMenu } from "./session-artifact-menu";
import { SessionChangesToggle } from "./session-changes-toggle";
import { ConversationActivity } from "./conversation-activity";
import { SessionMoreMenu } from "./session-more-menu";
import { WorkspaceModeControls } from "./workspace-mode-controls";

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
      {!resolved && <SessionChangesToggle session={paneSession} />}
      <SessionToolsGroup>
        <SessionArtifactMenu session={paneSession} />
        {!resolved && (
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
        )}
        <SessionMoreMenu
          session={paneSession}
          chatStore={paneSession.conversationSessionStore.chatStore}
        />
      </SessionToolsGroup>
    </>
  );
});
