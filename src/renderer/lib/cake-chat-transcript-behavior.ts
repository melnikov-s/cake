import { editorLocationFromPath } from "../../contracts/editor/editor-location";
import type { RootStore } from "../stores/RootStore";
import type { CakeChatSessionStore } from "../stores/CakeChatSessionStore";
import type { ChatTranscriptBehavior } from "../components/chat-transcript";

/** One transcript policy across ordinary, Browser and VS Code presentations. */
export function cakeChatTranscriptBehaviorFor(
  root: RootStore,
  session: CakeChatSessionStore,
): ChatTranscriptBehavior {
  const projectPath = root.cakeChatCollectionStore.summaries.find(
    (chat) => chat.sessionId === session.sessionId,
  )?.projectPath;
  return {
    workspacePath: projectPath,
    messageReferenceSessionId: session.sessionId,
    messageComments: session.messageCommentsStore,
    showSelectionContextMenu: (input) => root.showTranscriptSelectionContextMenu(input),
    subagents: session.subagentActivityStore,
    todos: session.todos,
    inlineWidgets: root.inlineWidgetStore,
    inlineArtifactPreviews: root.inlineArtifactPreviewStore,
    openSourceLocation: (location) => {
      const pane = root.cakeChatCollectionStore.sessionLayoutStore.paneForSession(
        session.sessionId,
      );
      if (pane) root.navigationStore.focusCakeChatPane(pane.paneId);
      void root.projectWorkbenchStore.presentationStore
        .openFile(editorLocationFromPath(location))
        .catch((error: unknown) =>
          root.toastStore.show({
            tone: "error",
            title: "Could not open file",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    },
  };
}
