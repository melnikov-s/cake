import { observer, useStore } from "r-state-tree/react";
import { WorkspaceModeControls } from "@/components/workspace-mode-controls";
import { RootStore } from "../stores/RootStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { SessionArtifactMenu } from "./session-artifact-menu";

export const ProjectWorkspaceControls = observer(function ProjectWorkspaceControls({
  session,
  mode,
  browserMode,
}: {
  session: ProjectSessionStore;
  mode: Exclude<ProjectSessionStore["presentationMode"], "normal">;
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const terminal = root.terminalStore;
  return (
    <>
      <SessionArtifactMenu session={session} />
      <WorkspaceModeControls
        mode={mode}
        chat={session.conversationSessionStore.chatStore}
        treeOpen={store.commandPaneStore.pane === "tree"}
        terminalAvailable={terminal.available}
        terminalOpen={terminal.open}
        browserHost={browserMode}
        onToggleTree={() => {
          void store.presentationStore.backToAgent().then(() => {
            if (store.activeSession?.presentationMode === "normal")
              store.commandPaneStore.toggle("tree");
          });
        }}
        onBackToAgent={() => void store.presentationStore.backToAgent()}
        onOpenDraw={() => void store.presentationStore.openDraw()}
        onOpenBrowser={() => void store.presentationStore.openBrowser()}
        onOpenIde={() => void store.presentationStore.openIde()}
        onToggleTerminal={() => void terminal.toggle()}
      />
    </>
  );
});
