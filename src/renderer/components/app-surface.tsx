import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { ArtifactLibrarySurface } from "./artifact-library-surface";
import { CakeChatSurface } from "./cake-chat-surface";
import { ProjectConversationSurface } from "./project-conversation-surface";
import { SettingsPage } from "./settings-page";
import { WorkbenchLanding } from "./workbench-landing";

export const AppSurface = observer(function AppSurface({ browserMode }: { browserMode: boolean }) {
  const root = useStore(RootStore);
  switch (root.appShellStore.surface) {
    case "settings":
      return (
        <div className="h-full min-h-0 w-full overflow-hidden">
          <SettingsPage settings={root.settingsStore} browserMode={browserMode} />
        </div>
      );
    case "artifact-library":
      return <ArtifactLibrarySurface />;
    case "cake-chat":
      return <CakeChatSurface />;
    case "workbench":
      return root.projectWorkbenchStore.activeSession ? (
        <ProjectConversationSurface browserMode={browserMode} />
      ) : (
        <WorkbenchLanding />
      );
  }
});
