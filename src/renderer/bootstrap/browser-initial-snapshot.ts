import type { StoreSnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";

/** Apply phone defaults only at page entry, before restoring the mounted tree. */
export function browserInitialSnapshot(
  saved: StoreSnapshot | undefined,
  phoneLayout: boolean,
): StoreSnapshot {
  const snapshot = saved ?? { state: {}, children: {} };
  if (!phoneLayout) return snapshot;
  // SAFETY: RootStore.sidebarStore is a singular @child Store, not a child array.
  const sidebar = snapshot.children.sidebarStore as StoreSnapshot | undefined;
  // SAFETY: RootStore.appShellStore is also a singular @child Store.
  const shell = snapshot.children.appShellStore as StoreSnapshot | undefined;
  const selection = { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID };
  return {
    ...snapshot,
    children: {
      ...snapshot.children,
      appShellStore: {
        ...shell,
        state: { ...shell?.state, selection, activeConversation: selection },
        children: shell?.children ?? {},
      },
      sidebarStore: {
        ...sidebar,
        state: { ...sidebar?.state, hidden: true },
        children: sidebar?.children ?? {},
      },
    },
  };
}
