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
import { Callout } from "@/components/ui/callout";
import { DialogBackdrop } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import {
  BackIcon,
  BrowseIcon,
  ChangesIcon,
  ChatIcon,
  FolderIcon,
  SettingsIcon,
  SidebarIcon,
  TerminalIcon,
  TreeIcon,
} from "@/components/ui/icons";
import { LoadingState } from "@/components/ui/loading-state";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { IdeWorkspace } from "@/components/ide-workspace";
import { SettingsPage } from "@/components/settings-page";
import { ToastHost } from "@/components/toast-host";
import { WorktreePill } from "@/components/worktree-pill";
import { WorkLogControls } from "@/components/work-log-controls";
import { Sidebar } from "@/components/sidebar";
import { ErrorNotice } from "@/components/error-notice";
import { SessionContinuationDialog } from "@/components/session-continuation-dialog";
import { ArtifactsPanel } from "@/components/artifacts-panel";
import { UiDialog } from "@/components/ui-dialog";
import { CommandPane } from "@/components/command-pane";
import { Chat } from "@/components/chat";
import { QuakeTerminal } from "@/components/quake-terminal";
import { terminalToggleAcceleratorHint } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { SourceLocation } from "../ipc/source-location";
import { toWorkspaceRelativePath } from "../utils/workspace-relative-path";
import { RootStore } from "./stores/RootStore";

export const App = observer(function App() {
  const root = useStore(RootStore);
  const store = root.projectWorkbenchStore;
  const sidebar = root.sidebarStore;
  const projects = root.projectCatalogStore;
  const reviews = root.reviewsStore;
  const settings = root.settingsStore;
  const session = store.activeSession;
  const composer = session?.composerStore;
  const chatConfiguration = session?.configurationStore;
  const extensionUi = root.extensionUiStore;
  const artifactInteractions = session?.artifactInteractionStore;
  const shell = root.appShellStore;
  const terminal = root.terminalStore;
  const surface = shell.surface;
  const globalChat = surface === "global-chat" ? root.globalChatStore : undefined;
  const cakeChatSession =
    globalChat && shell.selection.kind === "cake-chat" && shell.selection.sessionId
      ? globalChat.findSession(shell.selection.sessionId)
      : undefined;
  const workbenchError = store.contextError(session?.sessionId);
  const chatError =
    workbenchError?.message ??
    composer?.error ??
    reviews.error ??
    chatConfiguration?.error ??
    extensionUi.error ??
    artifactInteractions?.error;
  const chatErrorDetails = workbenchError
    ? workbenchError.details
    : composer?.error
      ? composer.errorDetails
      : reviews.error
        ? reviews.errorDetails
        : chatConfiguration?.error
          ? chatConfiguration.errorDetails
          : extensionUi.error
            ? extensionUi.errorDetails
            : artifactInteractions?.errorDetails;
  const sidebarCollapsed = sidebar.hidden;
  const sidebarWidth = sidebar.width;
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
  const toggleSidebar = useCallback(() => sidebar.toggle(), [sidebar]);
  const setSidebarWidth = useCallback((width: number) => sidebar.setWidth(width), [sidebar]);
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
        workspacePath: session.workspacePath,
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
          root.showTranscriptSelectionContextMenu(input),
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
  const projectSidebar = (
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
      onRemoveProject={(path, deleteSessions) => root.removeProject(path, deleteSessions)}
      onChooseProject={chooseProject}
      onGoBack={goBack}
      onGoForward={goForward}
    />
  );
  const sessionIsTemporary = session
    ? store.sessionRegistry.isTemporarySession(session.sessionId)
    : false;
  const sessionIsDraft = session ? store.sessionRegistry.isDraftSession(session.sessionId) : false;
  const worktreeConfigurationMode = sessionIsDraft
    ? session?.composerStore.editingDraftSession
      ? "edit-draft"
      : "activate-draft"
    : sessionIsTemporary
      ? "new-session"
      : undefined;
  const projectComposerHeader = session ? (
    <WorktreePill
      creation={store.worktreeCreationStore}
      actions={session.worktreeStore}
      record={root.sessionCatalogStore.managedWorktree(session.workspacePath)}
      sessionId={session.sessionId}
      projectPath={
        root.sessionCatalogStore.projectOfManagedWorktree(session.workspacePath) ??
        session.workspacePath
      }
      configurationMode={worktreeConfigurationMode}
      onConfigured={() => session.composerStore.requestFocus()}
    />
  ) : undefined;

  if (store.embeddedEditorStore.visible && session && projectTranscriptBehavior)
    return (
      <>
        <StoreProvider key={session.sessionId} store={session}>
          <IdeWorkspace
            editor={store.embeddedEditorStore}
            reviews={reviews}
            projectSidebar={projectSidebar}
            projectSidebarVisible={!sidebarCollapsed}
            projectSidebarWidth={sidebarWidth}
            onProjectSidebarWidthChange={setSidebarWidth}
            projectChat={session.chatStore}
            projectComposerHeader={projectComposerHeader}
            sessionTitle={store.sessionTitle}
            transcriptBehavior={projectTranscriptBehavior}
          />
        </StoreProvider>
        <QuakeTerminal store={terminal} />
      </>
    );
  const shellStyle: CSSProperties & Record<"--sidebar-width" | "--right-pane-width", string> = {
    "--sidebar-width": sidebarCollapsed ? "0px" : `${Math.min(sidebarWidth, sidebarMax)}px`,
    "--right-pane-width": store.commandPaneStore.pane
      ? `${Math.min(commandPaneWidth, commandPaneMax)}px`
      : "0px",
  };
  return (
    <main
      className={cn(
        "relative grid h-screen w-screen max-w-[100vw] overflow-hidden bg-background text-foreground transition-[grid-template-columns] duration-180 ease-out",
        "grid-cols-[var(--sidebar-width)_minmax(0,1fr)_var(--right-pane-width)] max-[820px]:grid-cols-[min(var(--sidebar-width),230px)_minmax(0,1fr)_var(--right-pane-width)] max-[620px]:grid-cols-[0px_minmax(0,1fr)]",
        resizingPanel && "cursor-col-resize select-none transition-none",
      )}
      style={shellStyle}
    >
      {!sidebarCollapsed && projectSidebar}
      {!sidebarCollapsed && (
        <ResizeHandle
          className="left-[calc(var(--sidebar-width)-5px)] max-[820px]:left-[calc(min(var(--sidebar-width),230px)-5px)]"
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
        data-slot="workspace"
        className="relative col-start-2 grid h-full min-h-0 min-w-0 grid-rows-[52px_minmax(0,1fr)] overflow-hidden [contain:inline-size]"
        data-session-id={
          shell.selection.kind === "cake-chat"
            ? shell.selection.sessionId
            : shell.selection.kind === "project-session"
              ? shell.selection.sessionId
              : undefined
        }
      >
        <IconButton
          className={cn(
            "absolute bottom-[9.5px] left-4 z-20 hidden size-8 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground max-[620px]:grid",
            sidebarCollapsed && "grid",
            surface === "settings" && "bg-sidebar-hover text-foreground",
          )}
          data-slot="workspace-settings"
          tooltip="Open settings"
          aria-current={surface === "settings" ? "page" : undefined}
          onClick={() => root.showSettings()}
        >
          <SettingsIcon />
        </IconButton>
        <header
          data-slot="workspace-header"
          className={cn(
            "relative flex h-[52px] w-full max-w-full min-w-0 items-center justify-between overflow-hidden border-b border-border/65 px-5 [app-region:drag] max-[620px]:pl-[84px]",
            sidebarCollapsed && "pl-[124px]",
          )}
        >
          <div className="flex w-0 min-w-0 flex-1 items-center gap-3">
            <IconButton
              className={cn(
                "absolute left-[84px] top-[9px] z-20 size-7 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground [app-region:no-drag]",
                sidebarCollapsed ? "grid" : "hidden max-[620px]:grid",
              )}
              data-slot="header-sidebar-toggle"
              tooltip="Toggle sidebar"
              onClick={toggleSidebar}
            >
              <SidebarIcon />
            </IconButton>
            {surface === "settings" && (
              <IconButton
                className="grid size-7 place-items-center rounded-lg bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground [app-region:no-drag]"
                tooltip="Back to chat"
                onClick={returnToWorkbench}
              >
                <BackIcon />
              </IconButton>
            )}
            <strong className="block min-w-0 max-w-full truncate text-[13px] font-semibold">
              {surface === "settings"
                ? "Settings"
                : surface === "global-chat"
                  ? "Cake Chat"
                  : (extensionUi.title ?? (session ? store.sessionTitle : "Cake"))}
            </strong>
            {surface === "workbench" && store.projectPath && (
              <span className="truncate font-mono text-[10px] text-muted-foreground max-[820px]:hidden">
                {store.projectPath}
              </span>
            )}
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 [app-region:no-drag]">
            <div
              className="flex min-w-0 shrink-0 items-center gap-1.5"
              ref={setSessionHeaderHost}
            />
            <IconButton
              tooltip={`Terminal (${terminalToggleAcceleratorHint})`}
              disabled={!terminal.available}
              aria-pressed={terminal.open}
              onClick={() => void terminal.toggle()}
            >
              <TerminalIcon />
            </IconButton>
          </div>
        </header>
        {surface === "settings" ? (
          <div className="h-full min-h-0 w-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
            <SettingsPage store={store} settings={settings} configuration={chatConfiguration} />
          </div>
        ) : globalChat ? (
          cakeChatSession ? (
            <div className="grid h-full min-h-0 min-w-0">
              {sessionHeaderHost &&
                createPortal(
                  <div className="flex shrink-0 items-center gap-1">
                    <WorkLogControls store={cakeChatSession.chatStore} />
                  </div>,
                  sessionHeaderHost,
                )}
              <Chat
                store={cakeChatSession.chatStore}
                transcriptBehavior={cakeChatTranscriptBehavior}
                empty={
                  <div className="grid min-h-[calc(100vh-330px)] place-items-center content-center text-center p-10">
                    <span className="grid size-14 rotate-3 place-items-center rounded-bl-[14px] rounded-br-[20px] rounded-tl-[20px] rounded-tr-[14px] border border-border bg-card/75 shadow-[0_20px_70px_-30px_hsl(var(--shadow)/0.5)]">
                      <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
                        C
                      </span>
                    </span>
                    <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight">
                      What can I help you find or do?
                    </h1>
                    <p className="mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
                      Ask about your tasks, open one, or delegate work to it.
                    </p>
                  </div>
                }
              />
            </div>
          ) : (
            <div className="flex h-screen flex-col items-center justify-center gap-3.5 bg-background text-muted-foreground">
              <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
                C
              </span>
              <LoadingState label="Opening Cake Chat" />
            </div>
          )
        ) : !session ? (
          <div className="grid h-full min-h-0 min-w-0 place-items-center content-center overflow-y-auto p-10 text-center">
            <span className="grid size-14 rotate-3 place-items-center rounded-bl-[14px] rounded-br-[20px] rounded-tl-[20px] rounded-tr-[14px] border border-border bg-card/75 shadow-[0_20px_70px_-30px_hsl(var(--shadow)/0.5)]">
              <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
                C
              </span>
            </span>
            <h1 className="mt-5 font-display text-3xl font-semibold tracking-tight">
              What should we build?
            </h1>
            <p className="mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
              Open a project for durable workspace chats, or start a one-off chat from your home
              directory.
            </p>
            <div className="mt-6 flex gap-2.5">
              <Button
                size="lg"
                disabled={store.agentAvailability !== "available" || store.isBusy}
                onClick={() => void root.chooseProject()}
              >
                <FolderIcon /> Open project
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={store.agentAvailability !== "available" || store.isBusy}
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
          <StoreProvider key={session.sessionId} store={session}>
            {sessionHeaderHost &&
              createPortal(
                <>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      className="flex h-7.5 shrink-0 items-center gap-1.5 rounded-lg bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [app-region:no-drag]"
                      type="button"
                      aria-label="Open VS Code"
                      onClick={() => void store.openIde()}
                    >
                      <BrowseIcon />
                      <span>VS Code</span>
                    </button>
                    <button
                      className={cn(
                        "flex h-7.5 shrink-0 items-center gap-1.5 rounded-lg bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [app-region:no-drag]",
                        store.commandPaneStore.pane === "tree" && "bg-muted text-foreground",
                      )}
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
                        className="flex h-7.5 shrink-0 items-center gap-1.5 rounded-lg bg-transparent px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground [app-region:no-drag]"
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
                </>,
                sessionHeaderHost,
              )}
            <div className="h-full min-h-0 min-w-0 overflow-hidden">
              <Chat
                store={session.chatStore}
                transcriptBehavior={projectTranscriptBehavior}
                empty={
                  <div className="grid min-h-[calc(100vh-330px)] place-items-center content-center text-center p-10">
                    <span className="grid size-14 rotate-3 place-items-center rounded-bl-[14px] rounded-br-[20px] rounded-tl-[20px] rounded-tr-[14px] border border-border bg-card/75 shadow-[0_20px_70px_-30px_hsl(var(--shadow)/0.5)]">
                      <span className="grid size-[27px] select-none place-items-center rounded-bl-[6px] rounded-br-[9px] rounded-tl-[9px] rounded-tr-[6px] bg-foreground text-sm font-black tracking-tighter text-background -rotate-2">
                        C
                      </span>
                    </span>
                    <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight">
                      What should we build in <em>{store.projectName}</em>?
                    </h1>
                    <p className="mt-3 max-w-[470px] text-sm leading-relaxed text-muted-foreground">
                      Describe a task, ask a question, or type <code>/</code> for commands.
                    </p>
                  </div>
                }
                footer={
                  <ArtifactsPanel
                    session={session}
                    inlineWidgets={root.inlineWidgetStore}
                    onOpenSourceLocation={openSourceLocation}
                  />
                }
                error={chatError ? { message: chatError, details: chatErrorDetails } : undefined}
                composerHeader={projectComposerHeader}
                status={
                  extensionUi.statuses.length > 0 ? (
                    <div
                      className="mx-auto mt-1.5 flex w-full max-w-[51.25rem] gap-2.5 overflow-x-auto font-mono text-[10px] text-muted-foreground pointer-events-auto"
                      role="status"
                    >
                      {extensionUi.statuses.map((status) => (
                        <span key={status.key} className="whitespace-nowrap">
                          <strong className="text-foreground">{status.key}</strong> {status.text}
                        </span>
                      ))}
                    </div>
                  ) : undefined
                }
              />
            </div>
          </StoreProvider>
        )}
      </section>
      <CommandPane store={store} extensionUi={extensionUi} />
      {store.commandPaneStore.pane && (
        <ResizeHandle
          className="right-[calc(var(--right-pane-width)-5px)]"
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
        <DialogBackdrop>
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
        </DialogBackdrop>
      )}
      <SessionContinuationDialog store={store.sessionContinuationStore} />
      {extensionUi.request && (
        <DialogBackdrop>
          <UiDialog
            key={extensionUi.request.uiRequestId}
            request={extensionUi.request}
            extensionUi={extensionUi}
          />
        </DialogBackdrop>
      )}
      <ToastHost store={root.toastStore}>
        {extensionUi.notifications.map((notification) => (
          <button
            key={notification.id}
            type="button"
            className="w-full text-left"
            onClick={() => extensionUi.dismissNotification(notification.id)}
          >
            <Callout
              variant={
                notification.tone === "error"
                  ? "error"
                  : notification.tone === "warning"
                    ? "warning"
                    : "default"
              }
              className="shadow-md"
            >
              <strong className="text-xs">Extension</strong>
              <span className="text-[11px] text-muted-foreground">{notification.message}</span>
            </Callout>
          </button>
        ))}
      </ToastHost>
      <QuakeTerminal store={terminal} />
      {store.agentAvailability === "unavailable" && store.projectPath && (
        <div className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-xl border border-border bg-card p-2.5 px-3 text-xs shadow-lg">
          <span>{store.agentAvailabilityReason ?? "The coding agent is unavailable."}</span>
          <Button size="sm" onClick={() => void store.restartPi()}>
            Restart and reopen
          </Button>
        </div>
      )}
    </main>
  );
});
