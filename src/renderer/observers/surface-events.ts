import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused native surface events to their Store owner. */
export const observeSurfaceEvents = (runtime: RendererRuntime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.surfaces(),
    (event) => {
      if (event.type === "fullscreen-surface-close-requested")
        root.fullscreenSurfaceStore.requestClose(event.surfaceId);
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Surface event observation"),
    },
  );
