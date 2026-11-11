import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";
import { applyCakeChatTodosProjection } from "../reducers/CakeChatTodosReducer";

/** Projects the main-owned application state into its renderer Store owner. */
export const observeApplicationState = (runtime: Runtime, root: RootStore) =>
  runtime.observe(
    (client) => client.application.observeState(),
    (projection) => {
      applyCakeChatTodosProjection(root.props.projection.cakeChatTodos, projection);
      root.settingsStore.applyApplicationState(projection.revision, projection.state);
      root.widgetAttachmentStore.applyApplicationState(projection.revision, projection.state);
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "Application state observation"),
    },
  );
