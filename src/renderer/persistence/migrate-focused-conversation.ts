import type { StoreSnapshot } from "r-state-tree";

/** Serialized pre-v4 layout only. Never used by the mounted navigation Store. */
export type PersistedSplitLayout =
  | { kind: "pane"; paneId: string; history: readonly string[]; historyCursor: number }
  | { kind: "split"; first: PersistedSplitLayout; second: PersistedSplitLayout };

function child(snapshot: StoreSnapshot, name: string): StoreSnapshot | undefined {
  const value = snapshot.children[name];
  return value && !Array.isArray(value) ? value : undefined;
}

function collapse(snapshot: StoreSnapshot | undefined): StoreSnapshot | undefined {
  if (!snapshot) return undefined;
  // SAFETY: legacy layout fields are part of the persisted pre-v4 Store snapshot.
  const layout = snapshot.state.layout as PersistedSplitLayout | undefined;
  const panes: Extract<PersistedSplitLayout, { kind: "pane" }>[] = [];
  const visit = (node: PersistedSplitLayout) => {
    if (node.kind === "pane") panes.push(node);
    else {
      visit(node.first);
      visit(node.second);
    }
  };
  if (layout) visit(layout);
  const focused = panes.find((pane) => pane.paneId === snapshot.state.focusedPaneId) ?? panes[0];
  const retained = panes.filter((pane) => pane !== focused).flatMap((pane) => pane.history);
  const history = [...retained, ...(focused?.history ?? [])];
  return {
    ...snapshot,
    state: { history, historyCursor: focused ? retained.length + focused.historyCursor : -1 },
  };
}

/** v3 -> v4: retain conversation visits, choosing the old focused pane, discard split geometry. */
export function migrateFocusedConversation(snapshot: StoreSnapshot): StoreSnapshot {
  const shell = child(snapshot, "appShellStore");
  if (!shell || shell.state.navigationVersion === 4) return snapshot;
  const children = { ...snapshot.children };
  const project = collapse(child(snapshot, "sessionLayoutStore"));
  if (project) children.sessionLayoutStore = project;
  const collection = child(snapshot, "cakeChatCollectionStore");
  const chat = collection && collapse(child(collection, "sessionLayoutStore"));
  if (collection && chat)
    children.cakeChatCollectionStore = {
      ...collection,
      children: { ...collection.children, sessionLayoutStore: chat },
    };
  children.appShellStore = { ...shell, state: { ...shell.state, navigationVersion: 4 } };
  return { ...snapshot, children };
}
