import { startupSnapshot } from "./startup-snapshot";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { DesktopConnectionStore } from "../stores/DesktopConnectionStore";
import { createStore, mount, type StoreSnapshot } from "r-state-tree";
import type { Client } from "../client/Client";
import { RootStore } from "../stores/RootStore";
import type { RootProjection } from "../models/RootProjection";
import { migratePendingSessions } from "../persistence/migrate-pending-sessions";

export function mountRootStore(
  client: Client,
  snapshot: StoreSnapshot | undefined,
  flushWindowState: () => Promise<void>,
  projection: RootProjection,
  desktopConnection?: DesktopConnectionStore,
  canDeliver?: () => boolean,
  browserHost = false,
) {
  const root = mount(
    createStore(RootStore, {
      client: client,
      desktopConnection,
      canDeliver,
      browserHost,
      projection,
      flushWindowState,
    }),
    { snapshot: startupSnapshot(migratePendingSessions(snapshot ?? {})) },
  );
  if (import.meta.hot && !import.meta.env.SSR && import.meta.env.MODE !== "test")
    void import("../dev/inspector").then(({ registerRoot }) => {
      registerRoot("RootStore", root, root.signal);
      registerRoot("RootProjection", projection, root.signal);
    });
  // Presentation is session-local; a previously open editor/browser must not cover startup chat.
  root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID).showPresentation("normal");
  return root;
}
