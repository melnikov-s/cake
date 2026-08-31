import { createStore, mount } from "r-state-tree";
import type { DesktopClient } from "./desktop-client";
import { RootStore } from "./stores/RootStore";

export function mountRootStore(client: DesktopClient) {
  const root = mount(createStore(RootStore, { client }));
  void root.windowPersistence.hydrate();
  return root;
}
