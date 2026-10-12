import { createContext } from "r-state-tree";
import type { SessionContinuationStore } from "../SessionContinuationStore";

/** Active-session compaction and continuation-prompt dismissal. */
export const SessionContinuationContext =
  createContext<Pick<SessionContinuationStore, "toolCompactAt" | "tryCancelPrompt">>();
