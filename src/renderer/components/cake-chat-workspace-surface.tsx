import { observer, StoreProvider, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { cakeChatTranscriptBehaviorFor } from "../lib/cake-chat-transcript-behavior";
import { SessionAssistant } from "./session-assistant";
import { WorkspaceFrame } from "./workspace-frame";
import { CakeChatWorkspaceControls } from "./cake-chat-workspace-controls";
import { CakeChatComposerHeader } from "./cake-chat-composer-header";
import { ProjectTodoSelectionBar } from "./project-todo-selection-bar";
import { ConversationBreadcrumb } from "./conversation-breadcrumb";

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
        headerLeading={<ConversationBreadcrumb sessionId={session.sessionId} />}
        projectComposerLeadingAccessory={
          root.settingsStore.appearance.sessionAvatarsEnabled
            ? {
                visible: true,
                content: (
                  <SessionAssistant
                    store={root.sessionAssistantStore}
                    seed={session.sessionId}
                    labels={[]}
                    value={[]}
                    animated
                  />
                ),
              }
            : undefined
        }
        projectComposerHeader={<CakeChatComposerHeader session={session} />}
        headerActions={
          <CakeChatWorkspaceControls session={session} mode={mode} browserMode={browserMode} />
        }
        sessionTitle={
          root.cakeChatCollectionStore.summaries.find(
            (chat) => chat.sessionId === session.sessionId,
          )?.title ?? "Cake Chat"
        }
        conversationHeader={<ProjectTodoSelectionBar todos={session.todos} />}
        transcriptBehavior={cakeChatTranscriptBehaviorFor(root, session)}
      />
    </StoreProvider>
  );
});
