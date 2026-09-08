import { toStoreEvent } from "../events/StoreEvent";
import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused application events to their Store owners. */
export const observeApplicationEvents = (runtime: RendererRuntime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.application(),
    (event) => {
      const storeEvent = toStoreEvent(event);
      if (!storeEvent) return;
      try {
        if (storeEvent.type === "notification") {
          root.toastStore.show(storeEvent);
          return;
        }
        if (storeEvent.type === "project-session-control-requested") {
          void root.respondProjectSessionControl(storeEvent).catch((error) => {
            if (!root.signal.aborted)
              root.projectWorkbenchStore.setError(error, "Project Session control response");
          });
          return;
        }
        root.extensionUiStore.receive(storeEvent);
        root.projectWorkbenchStore.receive(storeEvent);
      } catch (error) {
        root.projectWorkbenchStore.setError(error, `Application event: ${storeEvent.type}`);
      }
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Application event observation"),
    },
  );
