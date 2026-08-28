import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { observer, StoreProvider, useStore } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  BackIcon,
  BrowseIcon,
  ChangesIcon,
  ChatIcon,
  FolderIcon,
  SettingsIcon,
  SidebarIcon,
  TreeIcon,
} from "@/components/ui/icons";
import { LoadingState } from "@/components/ui/loading-state";
import { IdeWorkspace } from "@/components/ide-workspace";
import { SettingsPage } from "@/components/settings-page";
import { PanelResizeHandle } from "@/components/panel-resize-handle";
import { ToastHost } from "@/components/toast-host";
import { WorktreeChip } from "@/components/worktree-chip";
import { WorkLogControls } from "@/components/work-log-controls";
import { Sidebar } from "@/components/sidebar";
import { ProjectSessionPluginRail } from "@/components/project-session-plugin-rail";
import { ErrorNotice } from "@/components/error-notice";
import { ArtifactsPanel } from "@/components/artifacts-panel";
import { UiDialog } from "@/components/ui-dialog";
import { CommandPane } from "@/components/command-pane";
import { Chat } from "@/components/chat";
import type { SourceLocation } from "../ipc/source-location";
import { toWorkspaceRelativePath } from "../utils/workspace-relative-path";
import { RootStore } from "./stores/RootStore";
import { Slot } from "./plugin-runtime";

export const App = observer(function App() {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const sidebar = root.sidebarStore;
  const projects = root.projectCatalogStore;
  const persistence = root.windowPersistence;
  const reviews = root.reviewsStore;
  const settings = root.settingsStore;
  const session = store.activeSession;
  const composer = session?.composerStore;
  const chatConfiguration = session?.configurationStore;
  const extensionUi = root.extensionUiStore;
  const artifactInteractions = session?.artifactInteractionStore;
  const shell = root.appShellStore;
  const surface = shell.surface;
  const globalChat = surface === "global-chat" ? root.globalChatStore : undefined;
  const cakeChatSession =
    globalChat && shell.selection.kind === "cake-chat" && shell.selection.sessionId
      ? globalChat.findSession(shell.selection.sessionId)
      : undefined;
  const chatError =
    persistence.error ??
    store.error ??
    composer?.error ??
    reviews.error ??
    chatConfiguration?.error ??
    extensionUi.error ??
    artifactInteractions?.error;
  const chatErrorDetails = persistence.error
    ? persistence.errorDetails
    : store.error
      ? store.errorDetails
      : composer?.error
        ? composer.errorDetails
        : reviews.error
          ? reviews.errorDetails
          : chatConfiguration?.error
            ? chatConfiguration.errorDetails
            : extensionUi.error
              ? extensionUi.errorDetails
              : artifactInteractions?.errorDetails;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(292);
  const [commandPaneWidth, setCommandPaneWidth] = useState(420);
  const [resizingPanel, setResizingPanel] = useState(false);
  const [sessionHeaderHost, setSessionHeaderHost] = useState<HTMLDivElement | null>(null);
  const sidebarMax = Math.max(
    240,
    window.innerWidth - (store.commandPaneStore.pane ? commandPaneWidth : 0) - 360,
  );
  const commandPaneMax = Math.max(
    320,
    window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth) - 360,
  );
  const returnToWorkbench = useCallback(() => {
    root.returnToWorkbench();
  }, [root]);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((value) => !value), []);
  const openSettings = useCallback(() => root.showSettings(), [root]);
  const openCakeChat = useCallback(
    (sessionId?: string) => {
      void root.openCakeChat(sessionId);
    },
    [root],
  );
  const createCakeChat = useCallback(() => {
    void root.startCakeChat();
  }, [root]);
  const openSession = useCallback(
    (sessionId: string) => {
      void root.openSession(sessionId);
    },
    [root],
  );
  const createSession = useCallback(
    (workspacePath: string) => {
      void root.createSession(workspacePath);
    },
    [root],
  );
  const chooseProject = useCallback(() => {
    void root.chooseProject();
  }, [root]);
  const goBack = useCallback(() => root.navigateBack(), [root]);
  const goForward = useCallback(() => root.navigateForward(), [root]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.appearance.theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [settings.appearance.theme]);
  useEffect(() => {
    document.title = extensionUi.title ? `${extensionUi.title} · Cake` : "Cake";
  }, [extensionUi.title]);
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") root.dismissTopSecondarySurface();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [root]);

  useEffect(() => {
    const navigateSessionHistory = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mac = /Mac/.test(navigator.userAgent);
      const back = mac
        ? event.metaKey && event.key === "["
        : event.altKey && event.key === "ArrowLeft";
      const forward = mac
        ? event.metaKey && event.key === "]"
        : event.altKey && event.key === "ArrowRight";
      if (!back && !forward) return;
      event.preventDefault();
      if (back) root.navigateBack();
      else root.navigateForward();
    };
    window.addEventListener("keydown", navigateSessionHistory);
    return () => window.removeEventListener("keydown", navigateSessionHistory);
  }, [root]);

  const openSourceLocation = useCallback(
    (location: SourceLocation) => {
      if (!session) return;
      void store
        .openFileInIde({
          ...location,
          path: toWorkspaceRelativePath(location.path, session.workspacePath),
        })
        .catch(() => undefined);
    },
    [session, store],
  );

  const projectTranscriptBehavior = session
    ? {
        onFork: (entryId: string) => {
          void store.sessionContinuationStore.forkAt(entryId);
        },
        onHandoff: (entryId: string) => {
          void store.sessionContinuationStore.handoffAt(entryId);
        },
        openSourceLocation,
        onOpenReviewRun: (threadId?: string) => {
          if (threadId) void store.openReviewThread(threadId);
        },
        waitingForUser: Boolean(extensionUi.request || artifactInteractions?.request),
        messageComments: session.messageCommentsStore,
        subagents: session.subagentActivityStore,
        showSelectionContextMenu: (input: { canChat: boolean; canAnnotate: boolean }) =>
          root.client.showTranscriptSelectionContextMenu(input),
        inlineWidgets: root.inlineWidgetStore,
        artifacts: {
          records: session.model.artifacts.map((artifact) => artifact.value),
          interaction: session.artifactInteractionStore,
        },
      }
    : undefined;
  const cakeChatTranscriptBehavior =
    globalChat && cakeChatSession
      ? {
          onHandoff: (entryId: string) => {
            void globalChat.handoff(cakeChatSession.sessionId, entryId);
          },
        }
      : undefined;

  if (!persistence.hydrated)
    return (
      <main className="loading-screen">
        <span className="cake-mark">C</span>
        <LoadingState label="Restoring Cake" />
      </main>
    );
  if (store.embeddedEditorStore.visible && session && projectTranscriptBehavior)
    return (
      <StoreProvider key={`${session.workspacePath}\u0000${session.sessionId}`} store={session}>
        <IdeWorkspace
          editor={store.embeddedEditorStore}
          reviews={reviews}
          projectChat={session.chatStore}
          sessionTitle={store.sessionTitle}
          transcriptBehavior={projectTranscriptBehavior}
        />
      </StoreProvider>
    );
  const shellStyle: CSSProperties & Record<"--sidebar-width" | "--right-pane-width", string> = {
    "--sidebar-width": `${Math.min(sidebarWidth, sidebarMax)}px`,
    "--right-pane-width": `${Math.min(commandPaneWidth, commandPaneMax)}px`,
  };
  return (
    <main
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${store.commandPaneStore.pane ? "right-pane-open" : ""} ${resizingPanel ? "is-resizing" : ""}`}
      style={shellStyle}
    >
      <Sidebar
        store={sidebar}
        projects={projects}
        chat={store}
        cakeChat={root.globalChatStore}
        shell={shell}
        onToggle={toggleSidebar}
        onOpenSettings={openSettings}
        onOpenCakeChat={openCakeChat}
        onCreateCakeChat={createCakeChat}
        onOpenSession={openSession}
        onCreateSession={createSession}
        onChooseProject={chooseProject}
        onGoBack={goBack}
        onGoForward={goForward}
      />
      {!sidebarCollapsed && (
        <PanelResizeHandle
          className="sidebar-resize-handle"
          label="Resize project sidebar"
          value={sidebarWidth}
          min={220}
          max={sidebarMax}
          edge="left"
          onChange={setSidebarWidth}
          onResizeStart={() => setResizingPanel(true)}
          onResizeEnd={() => setResizingPanel(false)}
        />
      )}
      <section
        className="workspace"
        data-session-id={
          shell.selection.kind === "cake-chat"
            ? shell.selection.sessionId
            : shell.selection.kind === "project-session"
              ? shell.selection.sessionId
              : undefined
        }
      >
        <IconButton
          className={
            surface === "settings" ? "workspace-settings-icon active" : "workspace-settings-icon"
          }
          tooltip="Open settings"
          aria-current={surface === "settings" ? "page" : undefined}
          onClick={() => root.showSettings()}
        >
          <SettingsIcon />
        </IconButton>
        <header className="workspace-header">
          <div>
            <IconButton
              className="header-sidebar-toggle"
              tooltip="Toggle sidebar"
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <SidebarIcon />
            </IconButton>
            {surface === "settings" && (
              <IconButton
                className="header-back"
                tooltip="Back to chat"
                onClick={returnToWorkbench}
              >
                <BackIcon />
              </IconButton>
            )}
            <strong>
              {surface === "settings"
                ? "Settings"
                : surface === "global-chat"
                  ? "Cake Chat"
                  : (extensionUi.title ?? (session ? store.sessionTitle : "Cake"))}
            </strong>
            {surface === "workbench" && store.projectPath && <span>{store.projectPath}</span>}
          </div>
          <div className="workspace-header-actions" ref={setSessionHeaderHost} />
        </header>
        {surface === "settings" ? (
          <SettingsPage
            store={store}
            settings={settings}
            configuration={chatConfiguration}
            customization={root.customizationStore}
            onViewStateChange={() => persistence.schedule()}
          />
        ) : globalChat ? (
          cakeChatSession ? (
            <div className="workbench global-chat">
              {sessionHeaderHost &&
                createPortal(
                  <div className="header-pane-actions">
                    <WorkLogControls store={cakeChatSession.chatStore} />
                  </div>,
                  sessionHeaderHost,
                )}
              <Chat
                store={cakeChatSession.chatStore}
                transcriptBehavior={cakeChatTranscriptBehavior}
                empty={
                  <div className="chat-empty">
                    <span className="cake-orbit">
                      <span className="cake-mark">C</span>
                    </span>
                    <h1>What can I help you find or do?</h1>
                    <p>Ask about your tasks, open one, or delegate work to it.</p>
                  </div>
                }
              />
            </div>
          ) : (
            <div className="loading-screen">
              <span className="cake-mark">C</span>
              <LoadingState label="Opening Cake Chat" />
            </div>
          )
        ) : !session ? (
          <div className="welcome">
            <span className="cake-orbit">
              <span className="cake-mark">C</span>
            </span>
            <h1>What should we build?</h1>
            <p>
              Open a project for durable workspace chats, or start a one-off chat from your home
              directory.
            </p>
            <div>
              <Button
                size="lg"
                disabled={store.piState !== "ready" || store.isBusy}
                onClick={() => void root.chooseProject()}
              >
                <FolderIcon /> Open project
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={store.piState !== "ready" || store.isBusy}
                onClick={() => void root.startOneOffChat()}
              >
                <ChatIcon /> One-off chat
              </Button>
            </div>
            {chatError && (
              <ErrorNotice
                title="Operation failed"
                message={chatError}
                details={chatErrorDetails}
              />
            )}
          </div>
        ) : (
          <StoreProvider key={`${session.workspacePath}\u0000${session.sessionId}`} store={session}>
            {sessionHeaderHost &&
              createPortal(
                <>
                  <div className="header-pane-actions">
                    <WorktreeChip
                      store={store.worktreeStore}
                      currentProjectPath={store.projectPath}
                      onCreateWorktree={(projectPath) => {
                        store.worktreeCreationStore.request(projectPath);
                      }}
                      onFinished={(projectPath) => {
                        void root.createSession(projectPath);
                      }}
                      notify={root.toastStore.show}
                    />
                    <button
                      className="header-pane-toggle"
                      type="button"
                      aria-label="Open VS Code"
                      onClick={() => void store.openIde()}
                    >
                      <BrowseIcon />
                      <span>VS Code</span>
                    </button>
                    <button
                      className={`header-pane-toggle${store.commandPaneStore.pane === "tree" ? " active" : ""}`}
                      type="button"
                      aria-label="Session tree"
                      aria-pressed={store.commandPaneStore.pane === "tree"}
                      onClick={() => store.commandPaneStore.toggle("tree")}
                    >
                      <TreeIcon />
                      <span>Tree</span>
                    </button>
                    {store.activeSessionExists && (
                      <button
                        className="header-pane-toggle"
                        type="button"
                        aria-label="Open workspace changes in VS Code"
                        onClick={() => void store.openWorkspaceChanges()}
                      >
                        <ChangesIcon />
                        <span>Changes</span>
                      </button>
                    )}
                    <WorkLogControls store={session.chatStore} />
                  </div>
                  <div className="plugin-slot plugin-slot-project-session-header">
                    <Slot name="project-session.header.actions" />
                  </div>
                </>,
                sessionHeaderHost,
              )}
            <div className="workbench project-session-workbench">
              <ProjectSessionPluginRail side="left" />
              <Chat
                store={session.chatStore}
                transcriptBehavior={projectTranscriptBehavior}
                empty={
                  <div className="chat-empty">
                    <span className="cake-orbit">
                      <span className="cake-mark">C</span>
                    </span>
                    <h1>
                      What should we build in <em>{store.projectName}</em>?
                    </h1>
                    <p>
                      Describe a task, ask a question, or type <code>/</code> for commands.
                    </p>
                  </div>
                }
                footer={
                  <>
                    <ArtifactsPanel
                      session={session}
                      inlineWidgets={root.inlineWidgetStore}
                      onOpenSourceLocation={openSourceLocation}
                    />
                    <Slot name="project-session.transcript.after" />
                  </>
                }
                error={chatError ? { message: chatError, details: chatErrorDetails } : undefined}
                composerContent={<Slot name="project-session.composer.before" />}
                pluginActions={<Slot name="project-session.composer.actions" />}
                status={
                  <>
                    {extensionUi.statuses.length > 0 && (
                      <div className="extension-statuses" role="status">
                        {extensionUi.statuses.map((status) => (
                          <span key={status.key}>
                            <strong>{status.key}</strong> {status.text}
                          </span>
                        ))}
                      </div>
                    )}
                    <Slot name="project-session.status" />
                  </>
                }
              />
              <ProjectSessionPluginRail side="right" />
            </div>
          </StoreProvider>
        )}
      </section>
      <CommandPane store={store} extensionUi={extensionUi} />
      {store.commandPaneStore.pane && (
        <PanelResizeHandle
          className="command-pane-resize-handle"
          label="Resize command pane"
          value={commandPaneWidth}
          min={320}
          max={commandPaneMax}
          edge="right"
          onChange={setCommandPaneWidth}
          onResizeStart={() => setResizingPanel(true)}
          onResizeEnd={() => setResizingPanel(false)}
        />
      )}
      {store.pendingTrustPath && (
        <div className="dialog-backdrop">
          <Confirmation
            state="requested"
            role="alertdialog"
            aria-labelledby="trust-title"
            aria-describedby="trust-description"
          >
            <ConfirmationRequest>
              <ConfirmationTitle id="trust-title">Trust this workspace?</ConfirmationTitle>
              <ConfirmationDescription id="trust-description">
                {store.pendingTrustPath} contains project-local executable Pi resources. Trust it
                only if you know its contents.
              </ConfirmationDescription>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => void store.resolveProjectTrust(false)}
                >
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction onClick={() => void store.resolveProjectTrust(true)}>
                  Trust and open
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </div>
      )}
      {store.worktreeCreationStore.promptPath && (
        <div className="dialog-backdrop">
          <Confirmation
            state="requested"
            role="dialog"
            aria-labelledby="create-worktree-title"
            aria-describedby="create-worktree-description"
          >
            <ConfirmationRequest>
              <ConfirmationTitle id="create-worktree-title">Create a worktree?</ConfirmationTitle>
              <ConfirmationDescription id="create-worktree-description">
                Cake creates an isolated checkout in the background and this new session works
                there. Landing merges your commits back into {store.projectName} and removes it. The
                session stays part of this project.
              </ConfirmationDescription>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => store.worktreeCreationStore.cancel()}
                >
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction onClick={() => void store.worktreeCreationStore.confirm()}>
                  Create worktree
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </div>
      )}
      {store.sessionContinuationStore.prompt && (
        <div className="dialog-backdrop">
          <Confirmation
            state="requested"
            role="dialog"
            aria-labelledby="fork-worktree-title"
            aria-describedby="fork-worktree-description"
          >
            <ConfirmationRequest>
              <ConfirmationTitle id="fork-worktree-title">
                Fork into which worktree?
              </ConfirmationTitle>
              <ConfirmationDescription id="fork-worktree-description">
                This session works inside a Cake-managed worktree. Choose where the forked
                conversation should make its changes.
              </ConfirmationDescription>
              <ConfirmationActions>
                <ConfirmationAction
                  variant="ghost"
                  onClick={() => void store.sessionContinuationStore.resolvePrompt("cancel")}
                >
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => void store.sessionContinuationStore.resolvePrompt("existing")}
                >
                  Use the existing worktree
                </ConfirmationAction>
                <ConfirmationAction
                  onClick={() => void store.sessionContinuationStore.resolvePrompt("new-worktree")}
                >
                  Branch off a new worktree
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </div>
      )}
      {extensionUi.request && (
        <div className="dialog-backdrop">
          <UiDialog
            key={extensionUi.request.uiRequestId}
            request={extensionUi.request}
            extensionUi={extensionUi}
          />
        </div>
      )}
      <ToastHost store={root.toastStore}>
        {extensionUi.notifications.map((notification) => (
          <button
            key={notification.id}
            className={`notice notice-${notification.tone}`}
            onClick={() => extensionUi.dismissNotification(notification.id)}
          >
            <strong>Extension</strong>
            <span>{notification.message}</span>
          </button>
        ))}
      </ToastHost>
      {(store.piState === "failed" || store.piState === "stopped") && store.projectPath && (
        <div className="agent-recovery">
          <span>Pi runtime stopped.</span>
          <Button size="sm" onClick={() => void store.restartPi()}>
            Restart and reopen
          </Button>
        </div>
      )}
    </main>
  );
});
