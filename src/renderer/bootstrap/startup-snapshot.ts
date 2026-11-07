import type { StoreSnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { migrateNavigation } from "../persistence/migrate-navigation";

/** Startup policy, not a migration: retain conversation state, never restore a destination. */
export function startupSnapshot(saved: StoreSnapshot): StoreSnapshot {
  const snapshot = migrateNavigation(saved);
  const shell = snapshot.children.appShellStore;
  const collection = snapshot.children.cakeChatCollectionStore;
  // These are singular @child Stores, not keyed child arrays.
  if (Array.isArray(shell) || Array.isArray(collection))
    throw new Error("Invalid startup navigation snapshot");
  const layout = collection?.children.sessionLayoutStore;
  if (Array.isArray(layout)) throw new Error("Invalid Cake Chat layout snapshot");
  const shellState = { ...shell?.state };
  delete shellState.workspace;
  delete shellState.coveringSurface;
  const history = Array.isArray(layout?.state.history) ? [...layout.state.history] : [];
  if (history.at(-1) !== CAKE_CHAT_SESSION_ID) history.push(CAKE_CHAT_SESSION_ID);
  return {
    ...snapshot,
    children: {
      ...snapshot.children,
      appShellStore: {
        state: shellState,
        children: shell?.children ?? {},
      },
      cakeChatCollectionStore: {
        state: collection?.state ?? {},
        children: {
          ...collection?.children,
          sessionLayoutStore: {
            state: { ...layout?.state, history, historyCursor: history.length - 1 },
            children: layout?.children ?? {},
          },
        },
      },
    },
  };
}
