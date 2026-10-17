import { migrateNavigation } from "../persistence/migrate-navigation";
import type { StoreSnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";

/** Apply phone defaults only at page entry, before restoring the mounted tree. */
export function browserInitialSnapshot(
  saved: StoreSnapshot | undefined,
  phoneLayout: boolean,
): StoreSnapshot {
  if (!phoneLayout) return saved ?? { state: {}, children: {} };
  const snapshot = migrateNavigation(saved ?? { state: {}, children: {} });
  // SAFETY: RootStore.sidebarStore is a singular @child Store, not a child array.
  const sidebar = snapshot.children.sidebarStore as StoreSnapshot | undefined;
  // SAFETY: RootStore.appShellStore is also a singular @child Store.
  const shell = snapshot.children.appShellStore as StoreSnapshot | undefined;
  // SAFETY: RootStore.cakeChatCollectionStore is a singular @child Store.
  const collection = snapshot.children.cakeChatCollectionStore as StoreSnapshot | undefined;
  const paneId = crypto.randomUUID();
  return {
    ...snapshot,
    children: {
      ...snapshot.children,
      appShellStore: {
        ...shell,
        state: {
          ...shell?.state,
          navigationVersion: 2,
          workspace: "cake-chat",
          coveringSurface: undefined,
        },
        children: shell?.children ?? {},
      },
      cakeChatCollectionStore: {
        state: collection?.state ?? {},
        children: {
          ...collection?.children,
          sessionLayoutStore: {
            state: {
              layout: { kind: "pane", paneId, history: [CAKE_CHAT_SESSION_ID], historyCursor: 0 },
              focusedPaneId: paneId,
            },
            children: {},
          },
        },
      },
      sidebarStore: {
        ...sidebar,
        state: { ...sidebar?.state, hidden: true },
        children: sidebar?.children ?? {},
      },
    },
  };
}
