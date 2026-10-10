import { createContext } from "r-state-tree";
import type { SessionRegistryStore } from "../SessionRegistryStore";

/** The window-owned loaded Project Session registry. */
export const SessionRegistryContext = createContext<SessionRegistryStore>();
