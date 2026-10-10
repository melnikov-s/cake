import { createContext } from "r-state-tree";
import type { SessionMetadataStore } from "../SessionMetadataStore";

/** Shared Project Session metadata joins owned by RootStore. */
export const SessionMetadataContext = createContext<SessionMetadataStore>();
