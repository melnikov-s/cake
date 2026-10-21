import { createContext } from "react";

/** Transcript identity, independent of React/virtualizer mounts and the focused pane. */
export const InlineArtifactContext = createContext<
  { conversationId: string; partId: string } | undefined
>(undefined);
