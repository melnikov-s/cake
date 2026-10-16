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
  const closeNarrowNavigation = useCallback(() => {
    if (window.matchMedia("(max-width: 620px)").matches && sidebar.visible) sidebar.toggle();
  }, [sidebar]);
  const openSettings = () => {
    closeNarrowNavigation();
    root.navigationStore.showSettings();
  };
  const openCakeChat = useCallback(
    (sessionId?: string) => {
      closeNarrowNavigation();
      void root.navigationStore.openCakeChat(sessionId);
    },
    [root, closeNarrowNavigation],
  );
  const openSession = useCallback(
    (sessionId: string) => {
      closeNarrowNavigation();
      void root.navigationStore.openSession(sessionId);
    },
    [root, closeNarrowNavigation],
  );
  const createSession = useCallback(
    (workspacePath: string) => {
      closeNarrowNavigation();
      void root.navigationStore.createSession(workspacePath);
    },
    [root, closeNarrowNavigation],
  );
  const chooseProject = useCallback(() => {
    void root.navigationStore.chooseProject();
  }, [root]);
  const goBack = useCallback(() => {
    closeNarrowNavigation();
    root.navigationStore.navigateBack();
  }, [root, closeNarrowNavigation]);
  const goForward = useCallback(() => {
    closeNarrowNavigation();
    root.navigationStore.navigateForward();
  }, [root, closeNarrowNavigation]);
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
      onNewSession={() => {
        closeNarrowNavigation();
        root.newSessionStore.show();
      }}
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
