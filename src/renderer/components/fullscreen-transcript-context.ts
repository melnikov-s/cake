import { createContext } from "react";

/** A fullscreen surface keeps its owning transcript row mounted and stops covered scrolling. */
export const FullscreenTranscriptContext = createContext<{
  selectionOwnerId: string;
  retain(): () => void;
} | null>(null);
