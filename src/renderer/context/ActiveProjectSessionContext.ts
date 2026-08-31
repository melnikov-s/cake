import { createContext } from "r-state-tree";

export interface ActiveProjectSessionContextValue {
  readonly sessionId: string;
  readonly workingDirectory: string;
}

/** The Project Session currently selected by the window-owned RootStore. */
export const ActiveProjectSessionContext = createContext<
  ActiveProjectSessionContextValue | undefined
>(undefined);
