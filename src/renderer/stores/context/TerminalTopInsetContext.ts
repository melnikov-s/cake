import { createContext } from "r-state-tree";

/** Window-local native-view clearance, derived by TerminalStore; never persisted. */
export const TerminalTopInsetContext = createContext<number>(0);
