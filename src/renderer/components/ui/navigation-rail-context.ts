import { createContext } from "react";

/** Portal interaction retention; label disclosure uses NavigationRailLabelsContext. */
export const NavigationRailContext = createContext<{
  retain(owner: symbol, open: boolean): void;
} | null>(null);
