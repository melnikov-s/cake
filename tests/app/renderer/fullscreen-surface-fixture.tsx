import { useEffect, useState, type ReactNode } from "react";
import { createStore, mount } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { FullscreenSurfaceStore } from "../../../src/renderer/stores/FullscreenSurfaceStore";

export function FullscreenSurfaceFixture({ children }: { children: ReactNode }) {
  const [store] = useState(() =>
    mount(
      createStore(FullscreenSurfaceStore, {
        setOpen: async () => undefined,
      }),
    ),
  );
  useEffect(() => () => store[Symbol.dispose](), [store]);
  return <StoreProvider store={store}>{children}</StoreProvider>;
}
