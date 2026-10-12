import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { useAppDocument } from "../hooks/use-app-document";
import { useAppFullscreenResponse } from "../hooks/use-app-fullscreen-response";
import { useAppHotkeys } from "../hooks/use-app-hotkeys";
import { AppOverlayHost } from "./app-overlay-host";
import { AppShellLayout } from "./app-shell-layout";
import { AppSurface } from "./app-surface";
import { ProjectWorkspaceSurface } from "./project-workspace-surface";

export const App = observer(function App({ browserMode = false }: { browserMode?: boolean }) {
  const root = useStore(RootStore);
  // Keep this geometry across switches to full workspace layouts.
  const [commandPaneWidth, setCommandPaneWidth] = useState(420);
  useAppDocument(root);
  const fullscreen = useAppFullscreenResponse(root);
  useAppHotkeys(root, fullscreen.openResponse);

  const workbench = root.projectWorkbenchStore;
  const session = workbench.activeSession;
  const presentation = workbench.presentationStore;
  const mode =
    root.appShellStore.surface === "workbench" && session && !workbench.activeSessionResolved
      ? session.presentationMode === "draw"
        ? "draw"
        : session.presentationMode === "browser" && presentation.browserStore.visible
          ? "browser"
          : session.presentationMode === "vscode" && presentation.embeddedEditorStore.visible
            ? "vscode"
            : undefined
      : undefined;
  const overlays = <AppOverlayHost workspaceMode={Boolean(mode)} fullscreen={fullscreen} />;

  return mode && session ? (
    <>
      <ProjectWorkspaceSurface session={session} mode={mode} browserMode={browserMode} />
      {overlays}
    </>
  ) : (
    <AppShellLayout
      overlays={overlays}
      commandPaneWidth={commandPaneWidth}
      onCommandPaneWidthChange={setCommandPaneWidth}
    >
      <AppSurface browserMode={browserMode} />
    </AppShellLayout>
  );
});
