import { createContext } from "r-state-tree";
import type { ProjectWorkbenchStore } from "../ProjectWorkbenchStore";

/** Selected-session intents and queries; consumers cannot traverse workbench children. */
export const ProjectSessionNavigationContext =
  createContext<
    Pick<
      ProjectWorkbenchStore,
      | "activeSessionId"
      | "openSession"
      | "showLoadedSession"
      | "startNewSession"
      | "sessionContext"
      | "canSubmitSession"
      | "dismissSecondarySurfaces"
      | "requestComposerFocus"
      | "resolveWorktreeWorkspace"
      | "setError"
    >
  >();
