import { createContext } from "r-state-tree";
import type { SessionPresentationStore } from "../SessionPresentationStore";

/** Presentation intents without exposing native editor or browser implementation Stores. */
export const SessionPresentationContext =
  createContext<
    Pick<
      SessionPresentationStore,
      | "restore"
      | "openSelectionLocation"
      | "refreshEditorHighlights"
      | "openFile"
      | "openWorkspaceChanges"
    >
  >();
