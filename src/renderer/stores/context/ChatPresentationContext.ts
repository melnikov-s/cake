import { createContext } from "r-state-tree";
import type { WorkLogPresentationCapabilities } from "../WorkLogPresentationStore";

/** Shared preference authority; individual chats may still supply explicit overrides. */
export interface ChatPresentationPreferences {
  hideThinking(): boolean;
  workLogPresentation: WorkLogPresentationCapabilities;
}

export const ChatPresentationContext = createContext<ChatPresentationPreferences>();
