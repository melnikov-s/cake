import { createContext } from "react";

export interface ChatTranscriptControls {
  scrollToBottom(): void;
}

export const ChatTranscriptControlsContext = createContext<ChatTranscriptControls | undefined>(
  undefined,
);
