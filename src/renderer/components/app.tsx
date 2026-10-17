import { useState } from "react";
import { usePhoneLayout } from "../lib/phone-layout";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { useAppDocument } from "../hooks/use-app-document";
import { useAppFullscreenResponse } from "../hooks/use-app-fullscreen-response";
import { useAppHotkeys } from "../hooks/use-app-hotkeys";
import { AppOverlayHost } from "./app-overlay-host";
import { AppShellLayout } from "./app-shell-layout";
import { AppSurface } from "./app-surface";
import { CakeChatWorkspaceSurface } from "./cake-chat-workspace-surface";
import { ProjectWorkspaceSurface } from "./project-workspace-surface";

export const App = observer(function App({ browserMode = false }: { browserMode?: boolean }) {
  const root = useStore(RootStore);
  // Keep this geometry across switches to full workspace layouts.
  const [commandPaneWidth, setCommandPaneWidth] = useState(420);
  useAppDocument(root);
  const fullscreen = useAppFullscreenResponse(root);
  useAppHotkeys(root, fullscreen.openResponse);

  const phone = usePhoneLayout();
  const workbench = root.projectWorkbenchStore;
  const session = root.workspaceSession;
  const presentation = workbench.presentationStore;
  const mode =
    !phone &&
    (root.appShellStore.surface === "workbench" || root.appShellStore.surface === "cake-chat") &&
    session &&
    !workbench.activeSessionResolved
      ? session.presentationMode === "browser" && presentation.browserStore.visible
        ? "browser"
        : session.presentationMode === "vscode" && presentation.embeddedEditorStore.visible
          ? "vscode"
          : undefined
      : undefined;
  const overlays = <AppOverlayHost workspaceMode={Boolean(mode)} fullscreen={fullscreen} />;

  return mode && session ? (
    <>
      {root.appShellStore.activeConversation?.kind === "cake-chat" ? (
        <CakeChatWorkspaceSurface
          session={root.cakeChatCollectionStore.registry.find(session.sessionId)!}
          mode={mode}
          browserMode={browserMode}
        />
      ) : (
        <ProjectWorkspaceSurface
          session={workbench.activeSession!}
          mode={mode}
          browserMode={browserMode}
        />
      )}
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
