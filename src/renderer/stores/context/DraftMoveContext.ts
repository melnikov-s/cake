import { createContext } from "r-state-tree";
import type { DraftMoveStore } from "../DraftMoveStore";

/** Window-owned draft moves, shared by normal and embedded conversation composers. */
export const DraftMoveContext = createContext<DraftMoveStore>();
