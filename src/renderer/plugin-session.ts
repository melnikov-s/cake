import { useStore } from "r-state-tree/react";
import { RootStore } from "./stores/RootStore";

/** Narrow host context available to plugins rendered for the selected project session. */
export interface CakePluginSession {
  workspacePath: string;
  sessionId: string;
  openChanges(): Promise<void>;
}

export function usePluginSession(): CakePluginSession {
  const root = useStore(RootStore);
  const selection = root.appShellStore.selection;
  if (selection.kind !== "project-session") {
    throw new Error("usePluginSession() requires a selected project session");
  }
  const { workspacePath, sessionId } = selection;
  return {
    workspacePath,
    sessionId,
    openChanges: () => root.openSessionChanges(workspacePath, sessionId)
  };
}
