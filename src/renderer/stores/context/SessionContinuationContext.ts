import { createContext } from "r-state-tree";
import type { SessionContinuationStore } from "../SessionContinuationStore";

/** Active-session tool pruning and continuation-prompt dismissal. */
export const SessionContinuationContext =
  createContext<Pick<SessionContinuationStore, "toolPruneAt" | "tryCancelPrompt">>();
