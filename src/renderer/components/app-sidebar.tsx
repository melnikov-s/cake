import { useCallback } from "react";
import { observer, useStore } from "r-state-tree/react";
import { Sidebar } from "@/components/sidebar";
import { RootStore } from "../stores/RootStore";

export const AppSidebar = observer(function AppSidebar() {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const sidebar = root.sidebarStore;
  const projects = root.projectCatalogStore;
  const shell = root.appShellStore;
  const toggleSidebar = () => sidebar.toggle();
  const openSettings = () => root.navigationStore.showSettings();
  const openCakeChat = useCallback(
    (sessionId?: string) => {
      void root.navigationStore.openCakeChat(sessionId);
    },
    [root],
  );
  const openSession = useCallback(
    (sessionId: string) => {
      void root.navigationStore.openSession(sessionId);
    },
    [root],
  );
  const createSession = useCallback(
    (workspacePath: string) => {
      void root.navigationStore.createSession(workspacePath);
    },
    [root],
  );
  const chooseProject = useCallback(() => {
    void root.navigationStore.chooseProject();
  }, [root]);
  const goBack = useCallback(() => root.navigationStore.navigateBack(), [root]);
  const goForward = useCallback(() => root.navigationStore.navigateForward(), [root]);
  return (
    <Sidebar
      store={sidebar}
      sessionList={sidebar.sessionListStore}
      sessionMetadata={root.sessionMetadataStore}
      projects={projects}
      chat={store}
      cakeChat={root.cakeChatCollectionStore}
      shell={shell}
      projectSettings={root.projectSettingsStore}
      appearance={root.settingsStore.appearance}
      onToggle={toggleSidebar}
      onOpenSettings={openSettings}
      onOpenCakeChat={openCakeChat}
      onNewSession={() => root.newSessionStore.show()}
      onOpenSession={openSession}
      onCreateSession={createSession}
      onRemoveProject={(path, deleteSessions) =>
        root.projectRemovalStore.remove(path, deleteSessions)
      }
      onChooseProject={chooseProject}
      onGoBack={goBack}
      onGoForward={goForward}
    />
  );
});
