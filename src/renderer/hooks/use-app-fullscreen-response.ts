import { useEffect, useState } from "react";
import type { RootStore } from "../stores/RootStore";

export interface FullscreenResponseSelection {
  sessionId: string;
  partId: string;
}

export function useAppFullscreenResponse(root: RootStore) {
  const [fullscreenResponse, setFullscreenResponse] = useState<FullscreenResponseSelection>();
  const shell = root.appShellStore;
  const currentChatSession =
    shell.surface === "workbench"
      ? root.projectWorkbenchStore.activeSession
      : shell.surface === "cake-chat" &&
          shell.selection.kind === "cake-chat" &&
          shell.selection.sessionId
        ? root.cakeChatCollectionStore.registry.find(shell.selection.sessionId)
        : undefined;
  const currentChatSessionId = currentChatSession?.sessionId;
  useEffect(() => setFullscreenResponse(undefined), [currentChatSessionId]);
  const fullscreenPart =
    currentChatSession &&
    fullscreenResponse &&
    currentChatSession.sessionId === fullscreenResponse.sessionId
      ? currentChatSession.conversationSessionStore.chatStore.parts.find(
          (part) =>
            part.id === fullscreenResponse.partId &&
            part.kind === "text" &&
            part.role === "assistant",
        )
      : undefined;
  return {
    currentChatSession,
    fullscreenPart,
    openResponse: setFullscreenResponse,
    closeResponse: () => setFullscreenResponse(undefined),
  };
}
