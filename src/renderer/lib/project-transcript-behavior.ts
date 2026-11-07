import { editorLocationFromPath } from "../../contracts/editor/editor-location";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import type { ChatTranscriptBehavior } from "../components/chat-transcript";

export function projectTranscriptBehaviorFor(
  root: RootStore,
  paneSession: ProjectSessionStore,
): ChatTranscriptBehavior {
  const store = root.projectWorkbenchStore;
  const extensionUi = root.extensionUiStore;
  const interviews = paneSession.conversationSessionStore.interviewStore;
  const resolved =
    paneSession.isForkPreview ||
    root.sessionCatalogStore.find(paneSession.sessionId)?.resolved === true;
  const projectPath =
    root.sessionCatalogStore.find(paneSession.sessionId)?.projectPath ?? paneSession.workspacePath;
  const projectChat = root.cakeChatCollectionStore.projectChat(projectPath);
  return {
    todos: projectChat
      ? root.cakeChatCollectionStore.registry.load(projectChat.sessionId).todos
      : undefined,
    workspacePath: paneSession.workspacePath,
    messageReferenceSessionId: paneSession.sessionId,
    onFork: resolved
      ? undefined
      : (entryId: string) => {
          void store.sessionContinuationStore.forkAt(entryId);
        },
    onTree: resolved
      ? undefined
      : (entryId: string) => {
          store.commandPaneStore.requestNavigation(entryId);
        },
    openSourceLocation: resolved
      ? undefined
      : (location: SourceLocation) => {
          void store.presentationStore
            .openFile(editorLocationFromPath(location))
            .catch((error: unknown) =>
              root.toastStore.show({
                tone: "error",
                title: "Could not open file",
                message: error instanceof Error ? error.message : String(error),
              }),
            );
        },
    onOpenReviewRun: resolved
      ? undefined
      : (threadId?: string) => {
          if (threadId) void store.presentationStore.openReviewThread(threadId);
        },
    waitingForUser:
      !resolved &&
      paneSession.sessionId === root.sessionLayoutStore.focusedSessionId &&
      Boolean(extensionUi.request || interviews.waiting),
    interviews: interviews.interviews,
    messageComments: resolved ? undefined : paneSession.messageCommentsStore,
    subagents: paneSession.subagentActivityStore,
    showSelectionContextMenu: resolved
      ? undefined
      : (input: { canChat: boolean; canAnnotate: boolean }) =>
          root.showTranscriptSelectionContextMenu(input),
    inlineWidgets: root.inlineWidgetStore,
    inlineArtifactPreviews: root.inlineArtifactPreviewStore,
    artifacts: {
      records: paneSession.sessionArtifactsStore.records,
    },
  };
}
