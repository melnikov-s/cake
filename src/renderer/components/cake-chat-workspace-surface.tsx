import { observer, StoreProvider, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import { cakeChatTranscriptBehaviorFor } from "../lib/cake-chat-transcript-behavior";
import { AppSidebar } from "./app-sidebar";
import { BrowserWorkspace } from "./browser-workspace";
import { IdeWorkspace } from "./ide-workspace";
import { QuakeTerminal } from "./quake-terminal";
import { SessionArtifactPane } from "./session-artifact-pane";
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
  const sidebar = root.sidebarStore;
  const presentation = root.projectWorkbenchStore.presentationStore;
  const terminal = root.terminalStore;
  const commonProps = {
    projectSidebar: <AppSidebar />,
    projectSidebarVisible: sidebar.visible,
    projectSidebarWidth: sidebar.focusModeProjectPath
      ? Math.max(sidebar.width, 360)
      : sidebar.width,
    onProjectSidebarWidthChange: (width: number) => sidebar.setWidth(width),
    projectComposerHeader: (
      <ConversationActivity
        placement="composer"
        sessionId={session.sessionId}
        subagents={session.subagentActivityStore}
        sideChat={session.conversationSessionStore.sideChatStore}
      />
    ),
    projectChat: session.conversationSessionStore.chatStore,
    sideChat: session.conversationSessionStore.sideChatStore,
    headerActions: (
      <CakeChatWorkspaceControls session={session} mode={mode} browserMode={browserMode} />
    ),
    sessionTitle:
      root.cakeChatCollectionStore.summaries.find((chat) => chat.sessionId === session.sessionId)
        ?.title ?? "Cake Chat",
    terminalDock: terminal.docked ? (
      <QuakeTerminal store={terminal} retirement={root.workingDirectoryRetirementStore} />
    ) : undefined,
    transcriptBehavior: cakeChatTranscriptBehaviorFor(root, session),
  };
  return (
    <StoreProvider key={session.sessionId} store={session}>
      <SessionArtifactPane sessionId={session.sessionId}>
        {mode === "browser" ? (
          <BrowserWorkspace
            {...commonProps}
            browser={presentation.browserStore}
            onToggleSidebar={() => sidebar.toggle()}
            onToggleChatSidebar={() => session.toggleWorkspaceChatSidebar()}
          />
        ) : (
          <IdeWorkspace
            {...commonProps}
            editor={presentation.embeddedEditorStore}
            selections={session.editorSelectionsStore}
            reviews={root.reviewsStore}
          />
        )}
      </SessionArtifactPane>
    </StoreProvider>
  );
});
