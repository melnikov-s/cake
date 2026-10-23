import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";
import { applyExperimentalFeaturesProjection } from "../reducers/ExperimentalFeaturesReducer";
import { applyCakeChatTodosProjection } from "../reducers/CakeChatTodosReducer";

/** Projects the main-owned application state into its renderer Store owner. */
export const observeApplicationState = (runtime: Runtime, root: RootStore) =>
  runtime.observe(
    (client) => client.application.observeState(),
    (projection) => {
      applyExperimentalFeaturesProjection(root.props.projection.experimentalFeatures, projection);
      applyCakeChatTodosProjection(root.props.projection.cakeChatTodos, projection);
      root.settingsStore.applyApplicationState(projection.revision, projection.state);
      root.sessionPluginStore.applyApplicationState(projection.revision, projection.state);
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Application state observation"),
    },
  );
