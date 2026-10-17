import type { ComponentProps } from "react";
import { observer, useStore } from "r-state-tree/react";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { RootStore } from "../stores/RootStore";
import { AppSidebar } from "./app-sidebar";
import { BrowserWorkspace } from "./browser-workspace";
import { IdeWorkspace } from "./ide-workspace";
import { QuakeTerminal } from "./quake-terminal";
import { SessionArtifactPane } from "./session-artifact-pane";

/** Shared composition only; the caller provides the workflow's exact-class Store scope. */
export const WorkspaceFrame = observer(function WorkspaceFrame({
  session,
  mode,
  ...slots
}: {
  session: ProjectSessionStore | CakeChatSessionStore;
  mode: "browser" | "vscode";
} & Pick<
  ComponentProps<typeof BrowserWorkspace>,
  | "headerActions"
  | "projectComposerHeader"
  | "projectComposerContent"
  | "projectComposerLeadingAccessory"
  | "sessionTitle"
  | "transcriptBehavior"
>) {
  const root = useStore(RootStore);
  const sidebar = root.sidebarStore;
  const presentation = root.projectWorkbenchStore.presentationStore;
  const terminal = root.terminalStore;
  const commonProps = {
    ...slots,
    projectSidebar: <AppSidebar />,
    projectSidebarVisible: sidebar.visible,
    projectSidebarWidth: sidebar.focusModeProjectPath
      ? Math.max(sidebar.width, 360)
      : sidebar.width,
    onProjectSidebarWidthChange: (width: number) => sidebar.setWidth(width),
    projectChat: session.conversationSessionStore.chatStore,
    sideChat: session.conversationSessionStore.sideChatStore,
    terminalDock: terminal.docked ? (
      <QuakeTerminal store={terminal} retirement={root.workingDirectoryRetirementStore} />
    ) : undefined,
  };

  return (
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
  );
});
