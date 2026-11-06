import type { StoreSnapshot } from "r-state-tree";
import { isProjectChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import type { PersistedSplitLayout } from "./migrate-focused-conversation";

/** v2 -> v3: move the old single Project Chat pane into the shared Project layout. */
export function migrateProjectChatLayout(snapshot: StoreSnapshot): StoreSnapshot {
  const child = (parent: StoreSnapshot, name: string) => {
    const value = parent.children[name];
    return value && !Array.isArray(value) ? value : undefined;
  };
  const shell = child(snapshot, "appShellStore");
  if (!shell || shell.state.navigationVersion === 3 || shell.state.navigationVersion === 4)
    return snapshot;
  const collection = child(snapshot, "cakeChatCollectionStore");
  const oldLayout = collection && child(collection, "sessionLayoutStore");
  // SAFETY: this is the serialized SessionLayoutStore.layout field; v2 allowed only one Cake Chat pane.
  const pane = oldLayout?.state.layout as PersistedSplitLayout | undefined;
  const sessionId = pane?.kind === "pane" ? pane.history[pane.historyCursor] : undefined;
  const children = { ...snapshot.children };
  const state: StoreSnapshot["state"] = { ...shell.state, navigationVersion: 3 };
  if (sessionId && isProjectChatSessionId(sessionId) && collection && oldLayout) {
    if (shell.state.workspace === "cake-chat") {
      state.workspace = "project-sessions";
      const projectLayout = child(snapshot, "sessionLayoutStore");
      const append = (node: PersistedSplitLayout): PersistedSplitLayout => {
        if (node.kind === "split")
          return { ...node, first: append(node.first), second: append(node.second) };
        if (node.paneId !== projectLayout?.state.focusedPaneId) return node;
        const history = [...node.history, sessionId];
        return { ...node, history, historyCursor: history.length - 1 };
      };
      // SAFETY: this is the same serialized SessionLayoutStore.layout field as the old layout above.
      const retained = projectLayout?.state.layout as PersistedSplitLayout | undefined;
      children.sessionLayoutStore = {
        state: {
          ...projectLayout?.state,
          layout: retained ? append(retained) : pane,
          focusedPaneId: projectLayout?.state.focusedPaneId ?? oldLayout.state.focusedPaneId,
        },
        children: projectLayout?.children ?? {},
      };
    }
    children.cakeChatCollectionStore = {
      ...collection,
      children: {
        ...collection.children,
        sessionLayoutStore: {
          ...oldLayout,
          state: { ...oldLayout.state, layout: undefined, focusedPaneId: undefined },
        },
      },
    };
  }
  children.appShellStore = { ...shell, state };
  return { ...snapshot, children };
}
