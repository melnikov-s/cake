import { useStore } from "r-state-tree/react";
import { RootStore } from "./stores/RootStore";
import type { SessionRef, WorkspaceRef } from "../ipc/plugin-agent-contract";

/** Narrow host context available to plugins rendered for the selected project session. */
export interface CakePluginSession {
  ref: SessionRef;
  workspace: WorkspaceRef;
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
    ref: { kind: "cake.session-ref", id: JSON.stringify({ sessionId }) },
    workspace: { kind: "cake.workspace-ref", id: JSON.stringify({ workspacePath }) },
    workspacePath,
    sessionId,
    openChanges: () => root.openSessionChanges(sessionId)
  };
}
