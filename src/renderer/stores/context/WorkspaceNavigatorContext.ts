import { createContext } from "r-state-tree";
import type { WorkspaceNavigatorStore } from "../WorkspaceNavigatorStore";

/** Window-owned Sessions/To-dos accessory presentation, never conversation authority. */
export const WorkspaceNavigatorContext = createContext<WorkspaceNavigatorStore>();
