import { createContext } from "r-state-tree";
import type { ArtifactPresentationContext as ViewContext } from "../../../contracts/artifacts/artifact-presentation-context";

export const ArtifactPresentationContext = createContext<{
  capture(sessionId: string): ViewContext | null | undefined;
}>();
