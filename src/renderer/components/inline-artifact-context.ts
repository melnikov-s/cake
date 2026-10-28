import { createContext } from "react";
import type { CanonicalTranscriptBehavior } from "./chat-message";

/** Transcript identity, independent of React/virtualizer mounts and the focused pane. */
export const InlineArtifactContext = createContext<
  { conversationId: string; partId: string; behavior?: CanonicalTranscriptBehavior } | undefined
>(undefined);
