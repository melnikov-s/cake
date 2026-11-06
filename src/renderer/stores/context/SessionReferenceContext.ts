import { createContext } from "r-state-tree";
import type { CapturePreferences } from "../../../contracts/desktop/screen-capture-data";

/** Shared session-destination catalog, without capture or navigation side effects. */
export const SessionReferenceContext = createContext<{
  readonly destinations: Omit<CapturePreferences, "defaultDestination">;
}>();
