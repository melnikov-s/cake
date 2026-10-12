import { createContext } from "r-state-tree";
import type { SessionManagementStore } from "../SessionManagementStore";

/** Window-owned Project Session mutations, independent of the displayed workbench. */
export const SessionManagementContext =
  createContext<
    Pick<
      SessionManagementStore,
      | "renameSession"
      | "ensureSessionActive"
      | "resolveSession"
      | "resolveSessionsById"
      | "deleteSession"
      | "setSessionLabels"
      | "setSessionUnread"
    >
  >();
