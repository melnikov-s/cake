import { createContext } from "react";

/** The artifact already occupying this chat's fullscreen workspace. */
export const ArtifactPresentationChatContext = createContext<string | null>(null);
