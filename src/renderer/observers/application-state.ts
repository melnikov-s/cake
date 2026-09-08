import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";

/** Projects the main-owned application state into its renderer Store owner. */
export const observeApplicationState = (runtime: RendererRuntime, root: RootStore) =>
  runtime.observe(
    (client) => client.application.observeState(),
    (projection) => root.settingsStore.applyApplicationState(projection.revision, projection.state),
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Application state observation"),
    },
  );
