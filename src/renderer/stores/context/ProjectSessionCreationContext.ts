import { createContext } from "r-state-tree";
import type { ProjectSessionCreationStore } from "../ProjectSessionCreationStore";

/** Window-owned staged activation and background Project Session creation. */
export const ProjectSessionCreationContext =
  createContext<
    Pick<
      ProjectSessionCreationStore,
      | "start"
      | "request"
      | "activateSavedDraft"
      | "configureDraftActivation"
      | "choice"
      | "candidates"
      | "createContinuationWorktree"
    >
  >();
