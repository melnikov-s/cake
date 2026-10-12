import { createContext } from "r-state-tree";
import type { SessionRetirementStore } from "../SessionRetirementStore";

/** Project Session retirement coordinated with this window's navigation and layout. */
export const SessionRetirementContext =
  createContext<
    Pick<
      SessionRetirementStore,
      "setProjectSessionResolved" | "setProjectSessionsResolved" | "deleteProjectSession"
    >
  >();
