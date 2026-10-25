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
          root.navigationStore.focusSessionPane(
            root.sessionLayoutStore.paneForSession(paneSession.sessionId)!.paneId,
          );
          void store.sessionContinuationStore.forkAt(entryId);
        },
    onTree: resolved
      ? undefined
      : (entryId: string) => {
          root.navigationStore.focusSessionPane(
            root.sessionLayoutStore.paneForSession(paneSession.sessionId)!.paneId,
          );
          store.commandPaneStore.requestNavigation(entryId);
        },
    openSourceLocation: resolved
      ? undefined
      : (location: SourceLocation) => {
          root.navigationStore.focusSessionPane(
            root.sessionLayoutStore.paneForSession(paneSession.sessionId)!.paneId,
          );
          void store.presentationStore
            .openFile(editorLocationFromPath(location))
            .catch(() => undefined);
        },
    onOpenReviewRun: resolved
      ? undefined
      : (threadId?: string) => {
          root.navigationStore.focusSessionPane(
            root.sessionLayoutStore.paneForSession(paneSession.sessionId)!.paneId,
          );
          if (threadId) void store.presentationStore.openReviewThread(threadId);
        },
    waitingForUser:
      !resolved &&
      paneSession.sessionId === root.sessionLayoutStore.focusedSessionId &&
      Boolean(extensionUi.visibleRequest || interviews.waiting),
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
