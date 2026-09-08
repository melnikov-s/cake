import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";

/** Projects the main-owned VS Code runtime state into its renderer Store owner. */
export const observeVsCodeState = (runtime: RendererRuntime, root: RootStore) =>
  runtime.observe(
    (client) => client.vscode.observeState(),
    (state) => root.projectWorkbenchStore.embeddedEditorStore.applyState(state),
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "VS Code state observation"),
    },
  );
