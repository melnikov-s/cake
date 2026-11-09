import { createContext } from "react";

/** Undefined outside a rail; inside, mirrors the rail’s actual label disclosure. */
export const NavigationRailLabelsContext = createContext<boolean | undefined>(undefined);
