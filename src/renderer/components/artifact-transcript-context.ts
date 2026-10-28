import { createContext } from "react";

/** View-local reading hold: a virtualized transcript must retain its presented artifact row. */
export const ArtifactTranscriptContext = createContext<{
  retain(): () => void;
} | null>(null);
