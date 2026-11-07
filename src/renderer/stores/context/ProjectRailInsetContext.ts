import { createContext } from "r-state-tree";

/** Native views paint above DOM overlays; reserve only the temporarily expanded rail. */
export const ProjectRailInsetContext = createContext<number>(0);
