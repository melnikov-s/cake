import { createContext } from "r-state-tree";
import type { DictationStore } from "../DictationStore";

/** Window voice-input lifecycle shared by all normal chat submission paths. */
export const DictationContext = createContext<() => DictationStore>();
