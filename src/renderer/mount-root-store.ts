import { createStore, mount, type StoreSnapshot } from "r-state-tree";
import type { Client } from "./client/Client";
import { RootStore } from "./stores/RootStore";
import type { RootProjection } from "./models/RootProjection";

export function mountRootStore(
  client: Client,
  snapshot: StoreSnapshot,
  flushWindowState: () => Promise<void>,
  projection: RootProjection,
) {
  const root = mount(
    createStore(RootStore, {
      client: client,
      projection,
      flushWindowState,
    }),
    { snapshot },
  );
  return root;
}
