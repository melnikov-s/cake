import { createStore, mount } from "r-state-tree";
import type { DesktopClient } from "./desktop-client";
import { RootStore } from "./stores/RootStore";
import type { ModelPresetSettingsStoreInstance } from "./stores/ModelPresetSettingsStore";

export function mountRootStore(
  client: DesktopClient,
  modelPresets: ModelPresetSettingsStoreInstance,
) {
  const root = mount(createStore(RootStore, { client, modelPresets }));
  void root.windowPersistence.hydrate();
  return root;
}
