import { createStore, mount } from "r-state-tree";
import type { DesktopClient } from "./desktop-client";
import type { RendererClient } from "./client/RendererClient";
import type { RendererModelSynchronizer } from "./RendererModelSynchronizer";
import { RootStore } from "./stores/RootStore";

export function mountRootStore(
  client: DesktopClient,
  rendererClient: RendererClient,
  synchronizer: RendererModelSynchronizer,
) {
  const root = mount(
    createStore(RootStore, { nativeClient: client, rendererClient, synchronizer }),
  );
  void Promise.all([root.windowPersistence.hydrate(), root.settingsStore.modelPresets.hydrate()]);
  return root;
}
