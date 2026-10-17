import { observer, StoreProvider, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { cakeChatTranscriptBehaviorFor } from "../lib/cake-chat-transcript-behavior";
import { WorkspaceFrame } from "./workspace-frame";
import { CakeChatWorkspaceControls } from "./cake-chat-workspace-controls";
import { ConversationActivity } from "./conversation-activity";

export const CakeChatWorkspaceSurface = observer(function CakeChatWorkspaceSurface({
  session,
  mode,
  browserMode,
}: {
  session: CakeChatSessionStore;
  mode: "browser" | "vscode";
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  return (
    <StoreProvider key={session.sessionId} store={session}>
      <WorkspaceFrame
        session={session}
        mode={mode}
        projectComposerHeader={
          <ConversationActivity
            placement="composer"
            sessionId={session.sessionId}
            subagents={session.subagentActivityStore}
            sideChat={session.conversationSessionStore.sideChatStore}
          />
        }
        headerActions={
          <CakeChatWorkspaceControls session={session} mode={mode} browserMode={browserMode} />
        }
        sessionTitle={
          root.cakeChatCollectionStore.summaries.find(
            (chat) => chat.sessionId === session.sessionId,
          )?.title ?? "Cake Chat"
        }
        transcriptBehavior={cakeChatTranscriptBehaviorFor(root, session)}
      />
    </StoreProvider>
  );
});
