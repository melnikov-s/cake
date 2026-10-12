import { observer, StoreProvider, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { projectTranscriptBehaviorFor } from "../lib/project-transcript-behavior";
import { AppSidebar } from "./app-sidebar";
import { BlockingInterviews } from "./blocking-interviews";
import { BrowserWorkspace } from "./browser-workspace";
import { DrawWorkspace } from "./draw-workspace";
import { IdeWorkspace } from "./ide-workspace";
import { ProjectComposerAccessory } from "./project-composer-accessory";
import { ProjectComposerHeader } from "./project-composer-header";
import { ProjectWorkspaceControls } from "./project-workspace-controls";
import { QuakeTerminal } from "./quake-terminal";
import { SessionArtifactPane } from "./session-artifact-pane";

export const ProjectWorkspaceSurface = observer(function ProjectWorkspaceSurface({
  session,
  mode,
  browserMode,
}: {
  session: ProjectSessionStore;
  mode: Exclude<ProjectSessionStore["presentationMode"], "normal">;
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const workbench = root.projectWorkbenchStore;
  const sidebar = root.sidebarStore;
  const terminal = root.terminalStore;
  const shell = root.appShellStore;
  const commonProps = {
    projectSidebar: <AppSidebar />,
    projectSidebarVisible: sidebar.visible,
    projectSidebarWidth: sidebar.focusModeProjectPath
      ? Math.max(sidebar.width, 360)
      : sidebar.width,
    onProjectSidebarWidthChange: (width: number) => sidebar.setWidth(width),
    projectChat: session.conversationSessionStore.chatStore,
    sideChat: session.conversationSessionStore.sideChatStore,
    headerActions: (
      <ProjectWorkspaceControls session={session} mode={mode} browserMode={browserMode} />
    ),
    projectComposerHeader: <ProjectComposerHeader session={session} recoverSavedDraft />,
    projectComposerContent: (
      <BlockingInterviews session={session} inlineWidgets={root.inlineWidgetStore} />
    ),
    projectComposerLeadingAccessory: root.settingsStore.appearance.sessionAvatarsEnabled
      ? { visible: true, content: <ProjectComposerAccessory session={session} /> }
      : undefined,
    sessionTitle: workbench.sessionTitle,
    terminalDock: terminal.docked ? (
      <QuakeTerminal store={terminal} retirement={root.workingDirectoryRetirementStore} />
    ) : undefined,
    transcriptBehavior: projectTranscriptBehaviorFor(root, session),
  };
  const workspace =
    mode === "draw" ? (
      <DrawWorkspace
        {...commonProps}
        draw={session.drawStore}
        sidebarCollapsed={!sidebar.visible}
        canGoBack={shell.canGoBack}
        canGoForward={shell.canGoForward}
        onToggleSidebar={() => sidebar.toggle()}
        onGoBack={() => root.navigationStore.navigateBack()}
        onGoForward={() => root.navigationStore.navigateForward()}
        chatSidebarVisible={session.workspaceChatSidebarVisible}
        chatSidebarWidth={session.workspaceChatSidebarWidth}
        onChatSidebarWidthChange={(width) => session.setWorkspaceChatSidebarWidth(width)}
        onToggleChatSidebar={() => session.toggleWorkspaceChatSidebar()}
      />
    ) : mode === "browser" ? (
      <BrowserWorkspace
        {...commonProps}
        browser={workbench.presentationStore.browserStore}
        onToggleSidebar={() => sidebar.toggle()}
        onToggleChatSidebar={() => session.toggleWorkspaceChatSidebar()}
      />
    ) : (
      <IdeWorkspace
        {...commonProps}
        editor={workbench.presentationStore.embeddedEditorStore}
        selections={session.editorSelectionsStore}
        reviews={root.reviewsStore}
      />
    );

  return (
    <StoreProvider key={session.sessionId} store={session}>
      <SessionArtifactPane sessionId={session.sessionId}>{workspace}</SessionArtifactPane>
    </StoreProvider>
  );
});
