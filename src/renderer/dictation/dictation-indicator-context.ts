import { createContext } from "react";

/** Optional DOM-only destination for a field's dictation control; undefined keeps it inline. */
export const DictationIndicatorContext = createContext<HTMLElement | null | undefined>(undefined);
