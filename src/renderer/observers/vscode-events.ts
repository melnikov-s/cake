import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused VS Code events to the Project Workbench Store. */
export const observeVsCodeEvents = (runtime: RendererRuntime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.vscode(),
    (event) => {
      try {
        if (event.type === "renderer-events-ready") return;
        if (event.type === "embedded-editor-toggle-mode-requested") {
          if (root.appShellStore.selection.kind === "project-session")
            void root.projectWorkbenchStore.toggleIde();
          return;
        }
        root.projectWorkbenchStore.receive(event);
      } catch (error) {
        root.projectWorkbenchStore.setError(error, `VS Code event: ${event.type}`);
      }
    },
    {
      reportFailure: (error) =>
        root.projectWorkbenchStore.setError(error, "VS Code event observation"),
    },
  );
