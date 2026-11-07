import { startupSnapshot } from "./startup-snapshot";
import type { StoreSnapshot } from "r-state-tree";

/** All hosts start in global Cake Chat; phones also hide the sidebar at page entry. */
export function browserInitialSnapshot(
  saved: StoreSnapshot | undefined,
  phoneLayout: boolean,
): StoreSnapshot {
  const snapshot = startupSnapshot(saved ?? { state: {}, children: {} });
  if (!phoneLayout) return snapshot;
  // SAFETY: RootStore.sidebarStore is a singular @child Store, not a child array.
  const sidebar = snapshot.children.sidebarStore as StoreSnapshot | undefined;
  return {
    ...snapshot,
    children: {
      ...snapshot.children,
      sidebarStore: {
        ...sidebar,
        state: { ...sidebar?.state, hidden: true },
        children: sidebar?.children ?? {},
      },
    },
  };
}
