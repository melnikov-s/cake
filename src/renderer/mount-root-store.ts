import { createStore, mount, type StoreSnapshot } from "r-state-tree";
import type { RendererClient } from "./client/RendererClient";
import { RootStore } from "./stores/RootStore";

export function mountRootStore(
  client: RendererClient,
  snapshot: StoreSnapshot,
  flushWindowState: () => Promise<void>,
) {
  const root = mount(
    createStore(RootStore, {
      rendererClient: client,
      flushWindowState,
    }),
    { snapshot },
  );
  void root.settingsStore.modelPresets.hydrate();
  return root;
}
