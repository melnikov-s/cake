import { useEffect, useState } from "react";
import type { RootStore } from "../stores/RootStore";

export interface FullscreenResponseSelection {
  sessionId: string;
  partId: string;
  renderKey?: string;
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
            part.kind === "text" &&
            part.role === "assistant" &&
            (part.id === fullscreenResponse.partId ||
              // Persistence replaces the live part id, but preserves its presentation identity.
              (Boolean(fullscreenResponse.renderKey) &&
                part.renderKey === fullscreenResponse.renderKey)),
        )
      : undefined;
  return {
    currentChatSession,
    fullscreenPart,
    openResponse: setFullscreenResponse,
    closeResponse: () => setFullscreenResponse(undefined),
  };
}
