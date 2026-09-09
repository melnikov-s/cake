import { toStoreEvent } from "../events/StoreEvent";
import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused application events to their Store owners. */
export const observeApplicationEvents = (runtime: Runtime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.application(),
    (event) => {
      const storeEvent = toStoreEvent(event);
      if (!storeEvent) return;
      try {
        if (storeEvent.type === "notification") {
          void root.notificationStore.enqueue({
            title: storeEvent.title,
            body: storeEvent.message,
            level: storeEvent.tone,
          });
          return;
        }
        if (storeEvent.type === "project-session-control-requested") {
          void root.applicationControlStore.handleProjectSessionRequest(storeEvent);
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
