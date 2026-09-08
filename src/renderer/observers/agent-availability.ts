import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";

/** Projects Pi agent availability into the renderer workflow that consumes it. */
export const observeAgentAvailability = (runtime: RendererRuntime, root: RootStore) =>
  runtime.observe(
    (client) => client.application.observeAgentAvailability(),
    (snapshot) => root.projectWorkbenchStore.applyAgentAvailability(snapshot),
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Agent availability observation"),
    },
  );
