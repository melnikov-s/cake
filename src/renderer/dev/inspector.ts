import type { Model, Store } from "r-state-tree";
import { connectViteInspector, createInspector } from "r-state-tree/devtools";
import { token } from "virtual:r-state-tree-inspector";

// Imported only inside import.meta.hot branches. No application control or eager child reads.
const inspector = import.meta.hot
  ? createInspector({
      controls: false,
      activity:
        import.meta.env.VITE_CAKE_RST_ACTIVITY === "1"
          ? { maxEntries: 200, redactValues: () => true }
          : false,
    })
  : undefined;
const registrations = new Set<() => void>();
let disposed = false;
const disconnect =
  inspector && import.meta.hot ? connectViteInspector(inspector, import.meta.hot, token) : () => {};

export function registerRoot(name: string, root: Store | Model, signal?: AbortSignal) {
  if (!inspector || disposed || signal?.aborted) return;
  const registration = inspector.registerRoot(name, root);
  const unregister = () => {
    registration.unregister();
    registrations.delete(unregister);
    signal?.removeEventListener("abort", unregister);
  };
  registrations.add(unregister);
  signal?.addEventListener("abort", unregister, { once: true });
}

function dispose() {
  if (disposed) return;
  disposed = true;
  disconnect();
  for (const unregister of registrations) unregister();
  inspector?.dispose();
  window.removeEventListener("pagehide", dispose);
}

if (import.meta.hot) {
  import.meta.hot.dispose(dispose);
  window.addEventListener("pagehide", dispose, { once: true });
}
