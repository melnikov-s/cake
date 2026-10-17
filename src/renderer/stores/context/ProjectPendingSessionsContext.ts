import { createContext } from "r-state-tree";
import type { ProjectPendingSessionsStore } from "../ProjectPendingSessionsStore";

/** Staged/saved Project Session state and commands, without its child collection or props. */
export const ProjectPendingSessionsContext =
  createContext<
    Pick<
      ProjectPendingSessionsStore,
      | "savedRecord"
      | "isDraft"
      | "isTemporary"
      | "updateSavedMetadata"
      | "conversation"
      | "setLabels"
      | "setConfiguration"
      | "deleteResolvedDraft"
      | "prepare"
      | "createDraft"
      | "projectSubmission"
      | "materialize"
      | "cancelSubmission"
      | "markActivated"
      | "relocate"
      | "updateDraft"
    >
  >();
