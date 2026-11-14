import { Schema } from "effect";
import type { StoreSnapshot } from "r-state-tree";

const isLegacyWidth = Schema.is(Schema.Number.check(Schema.isFinite()));

/** Seed each presentation's preference from the former shared width, before hydration. */
export function migrateWorkspaceSidebarWidths(snapshot: StoreSnapshot): StoreSnapshot {
  const navigator = snapshot.children.workspaceNavigatorStore;
  if (!navigator || Array.isArray(navigator) || !("width" in navigator.state)) return snapshot;
  const { width, ...state } = navigator.state;
  if (isLegacyWidth(width)) {
    state.chatWidth ??= width;
    state.vscodeWidth ??= width;
    state.browserWidth ??= width;
  }
  return {
    ...snapshot,
    children: {
      ...snapshot.children,
      workspaceNavigatorStore: { ...navigator, state },
    },
  };
}
