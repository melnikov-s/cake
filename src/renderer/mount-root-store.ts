import { createStore, mount, type StoreSnapshot } from "r-state-tree";
import type { RendererClient } from "./client/RendererClient";
import { RootStore } from "./stores/RootStore";
import type { RendererModels } from "./RendererModels";

export function mountRootStore(
  client: RendererClient,
  snapshot: StoreSnapshot,
  flushWindowState: () => Promise<void>,
  models: RendererModels,
) {
  const root = mount(
    createStore(RootStore, {
      rendererClient: client,
      models,
      flushWindowState,
    }),
    { snapshot },
  );
  return root;
}
