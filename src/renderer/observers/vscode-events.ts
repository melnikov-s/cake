import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";

/** Routes window-focused VS Code events to the Project Workbench Store. */
export const observeVsCodeEvents = (runtime: Runtime, root: RootStore) =>
  runtime.observe(
    (client) => client.events.vscode(),
    (event) => {
      try {
        if (event.type === "renderer-events-ready") return;
        if (event.type === "embedded-editor-navigation-reveal") {
          const editor = root.projectWorkbenchStore.presentationStore.embeddedEditorStore;
          if (
            editor.visible &&
            root.workspaceSession?.presentationMode === "vscode" &&
            event.workspacePath === editor.props.projectPath()
          )
            root.projectRailStore.setRevealed(event.revealed);
          return;
        }
        if (event.type === "embedded-editor-toggle-mode-requested") {
          if (root.appShellStore.selection.kind === "project-session")
            void root.projectWorkbenchStore.presentationStore.toggleIde();
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
