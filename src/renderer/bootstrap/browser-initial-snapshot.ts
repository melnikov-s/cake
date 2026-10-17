import type { StoreSnapshot } from "r-state-tree";

/** Apply phone defaults only at page entry, before restoring the mounted tree. */
export function browserInitialSnapshot(
  saved: StoreSnapshot | undefined,
  phoneLayout: boolean,
): StoreSnapshot {
  const snapshot = saved ?? { state: {}, children: {} };
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
