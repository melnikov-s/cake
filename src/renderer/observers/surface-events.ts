import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused native surface events to their Store owner. */
export const observeSurfaceEvents = (runtime: Runtime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.surfaces(),
    (event) => {
      if (event.type === "window-state-flush-requested")
        void root.props
          .flushWindowState()
          .then(
            () => root.props.client.windowState.respondFlush({ requestId: event.requestId }),
            (error: unknown) =>
              root.props.client.windowState.respondFlush({
                requestId: event.requestId,
                error: error instanceof Error ? error.message : String(error),
              }),
          )
          .catch((error: unknown) =>
            root.projectWorkbenchStore.setError(error, "Window close acknowledgement"),
          );
      if (event.type === "fullscreen-surface-close-requested")
        root.fullscreenSurfaceStore.requestClose(event.surfaceId);
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Surface event observation"),
    },
  );
