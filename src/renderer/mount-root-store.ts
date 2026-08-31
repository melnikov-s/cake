import { createStore, mount, type StoreSnapshot } from "r-state-tree";
import type { DesktopClient } from "./desktop-client";
import type { RendererClient } from "./client/RendererClient";
import { RootStore } from "./stores/RootStore";

export function mountRootStore(
  client: DesktopClient,
  rendererClient: RendererClient,
  snapshot: StoreSnapshot,
  flushWindowState: () => Promise<void>,
) {
  const root = mount(
    createStore(RootStore, {
      nativeClient: client,
      rendererClient,
      flushWindowState,
    }),
    { snapshot },
  );
  void root.settingsStore.modelPresets.hydrate();
  return root;
}
