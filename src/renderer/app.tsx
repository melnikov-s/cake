import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
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
import { Markdown } from "@/components/ai-elements/markdown";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  BackIcon,
  BrowseIcon,
  ChangesIcon,
  ChatIcon,
  ChevronIcon,
  FolderIcon,
  ForwardIcon,
  PlusIcon,
  SettingsIcon,
  SidebarIcon,
  TreeIcon,
} from "@/components/ui/icons";
import { LoadingState } from "@/components/ui/loading-state";
import { ArtifactHost } from "@/components/artifact-host";
import { ChangeExplorer } from "@/components/change-explorer";
import { WorkspaceBrowser } from "@/components/workspace-browser";
import { SettingsPage } from "@/components/settings-page";
import { SessionTree } from "@/components/session-tree";
import { PanelResizeHandle } from "@/components/panel-resize-handle";
import { CopyErrorDetailsButton } from "@/components/copy-error-details-button";
import { ToastHost } from "@/components/toast-host";
import { WorktreeChip } from "@/components/worktree-chip";
import { WorkLogControls } from "@/components/work-log-controls";
import { Chat } from "@/components/chat";
import { SidebarCakeChatGroup } from "@/components/sidebar-cake-chat-group";
import { SidebarProjectGroup } from "@/components/sidebar-project-group";
import { toWorkspaceRelativePath } from "../utils/workspace-relative-path";
import type { CompatibilityResource } from "../ipc/session-contract";
import type { ProjectWorkbenchStore } from "./stores/ProjectWorkbenchStore";
import type { ProjectSessionStore } from "./stores/ProjectSessionStore";
import type { ProjectCatalogStore } from "./stores/ProjectCatalogStore";
import type { SidebarStore } from "./stores/SidebarStore";
import { RootStore } from "./stores/RootStore";
import type { ExtensionUiStore, UiRequestState } from "./stores/ExtensionUiStore";
import type { InlineWidgetStore } from "./stores/InlineWidgetStore";
import type { GlobalChatStore } from "./stores/GlobalChatStore";
import type { AppShellStore } from "./stores/AppShellStore";
import { Slot } from "./plugin-runtime";

function ProjectSessionPluginRail({ side }: { side: "left" | "right" }) {
  return (
    <aside
      className={`project-session-plugin-rail project-session-plugin-rail-${side}`}
      aria-label={`${side === "left" ? "Left" : "Right"} session plugins`}
    >
      <div className="plugin-slot project-session-rail-slot project-session-rail-slot-top">
        <Slot name={`project-session.${side}.top`} />
      </div>
      <div className="plugin-slot project-session-rail-slot project-session-rail-slot-middle">
        <Slot name={`project-session.${side}.middle`} />
      </div>
      <div className="plugin-slot project-session-rail-slot project-session-rail-slot-bottom">
        <Slot name={`project-session.${side}.bottom`} />
      </div>
    </aside>
  );
}

const compatibilityResourceKinds: CompatibilityResource["kind"][] = [
  "extension",
  "skill",
  "prompt",
  "package",
];

// Observer-wrapped: reads ProjectWorkbenchStore.commandPane and
// session.compatibility resources/diagnostics directly, which the App observer
// does not read, so pane content must track those reads itself.
const CommandPane = observer(function CommandPane({
  store,
  extensionUi,
}: {
  store: ProjectWorkbenchStore;
  extensionUi: ExtensionUiStore;
}) {
  if (!store.commandPane || !store.session) return null;
  const title =
    store.commandPane === "tree"
      ? "Session tree"
      : store.commandPane === "changelog"
        ? "Pi changelog"
        : "Pi resources";
  const resourceGroups =
    store.commandPane === "resources"
      ? compatibilityResourceKinds.map((kind) => ({
          kind,
          resources: store.session!.compatibility.resources.filter((item) => item.kind === kind),
        }))
      : [];
  const diagnostics =
    store.commandPane === "resources"
      ? [
          ...new Map(
            [
              ...store.session.compatibility.diagnostics,
              ...extensionUi.compatibilityDiagnostics,
            ].map((item) => [item.id, item]),
          ).values(),
        ]
      : [];
  return (
    <aside className="command-pane secondary-surface" aria-labelledby="command-pane-title">
      <header>
        <div>
          <h2 id="command-pane-title">{title}</h2>
          {store.commandPane === "tree" && (
            <span>Navigate or fork without rewriting Pi history</span>
          )}
          {store.commandPane === "changelog" && <span>Version history for this agent runtime</span>}
        </div>
        <div>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Close ${title}`}
            onClick={() => store.closeCommandPane()}
          >
            Close
          </Button>
        </div>
      </header>
      {store.commandPane === "tree" ? (
        store.session.tree.length > 0 ? (
          <SessionTree
            nodes={store.session.tree}
            onNavigate={(id) => void store.navigateTo(id)}
            onFork={(id) => void store.forkAt(id)}
          />
        ) : (
          <p>This session has no branches yet.</p>
        )
      ) : store.commandPane === "changelog" ? (
        store.changelogLoading ? (
          <LoadingState label="Loading changelog" />
        ) : (
          <Markdown className="pi-changelog">
            {store.changelogMarkdown || "No changelog entries found."}
          </Markdown>
        )
      ) : (
        <div className="resource-catalog">
          {diagnostics.length > 0 && (
            <section className="resource-diagnostics">
              <h3>Diagnostics</h3>
              {diagnostics.map((item) => (
                <div key={item.id} className={`notice notice-${item.severity}`}>
                  <strong>{item.method ?? item.source}</strong>
                  <span>
                    {item.message}
                    {item.path ? `\n${item.path}` : ""}
                  </span>
                </div>
              ))}
            </section>
          )}
          {resourceGroups.map((group) => (
            <section key={group.kind}>
              <h3>
                {group.kind[0]!.toUpperCase() + group.kind.slice(1)}s{" "}
                <span>{group.resources.length}</span>
              </h3>
              {group.resources.length === 0 ? (
                <p>None discovered.</p>
              ) : (
                group.resources.map((resource) => (
                  <article key={resource.id}>
                    <div>
                      <strong>{resource.name}</strong>
                      <small>
                        {resource.scope} · {resource.origin}
                      </small>
                    </div>
                    {resource.description && <p>{resource.description}</p>}
                    {resource.commands.length > 0 && (
                      <p>
                        <b>Commands</b>{" "}
                        {resource.commands.map((command) => `/${command}`).join(", ")}
                      </p>
                    )}
                    {resource.tools.length > 0 && (
                      <p>
                        <b>Tools</b> {resource.tools.join(", ")}
                      </p>
                    )}
                    <code title={resource.path}>{resource.source}</code>
                  </article>
                ))
              )}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
});

function ErrorNotice({
  title,
  message,
  details = message,
}: {
  title: string;
  message: string;
  details?: string;
}) {
  return (
    <div className="notice notice-error" role="alert">
      <strong>{title}</strong>
      <span>{message}</span>
      {details && details !== message && (
        <details className="notice-error-details">
          <summary>Technical details</summary>
          <pre>{details}</pre>
        </details>
      )}
      <CopyErrorDetailsButton details={details} />
    </div>
  );
}

const ArtifactsPanel = observer(function ArtifactsPanel({
  session,
  inlineWidgets,
}: {
  session: ProjectSessionStore;
  inlineWidgets: InlineWidgetStore;
}) {
  const artifacts = session.artifactInteractionStore;
  const records = session.model.artifacts.map((artifact) => artifact.value);
  if (records.length === 0) return null;
  const linked = new Set(
    session.canonicalParts.flatMap((part) =>
      part.kind === "tool" && part.artifactId ? [part.artifactId] : [],
    ),
  );
  const unlinked = records.filter((record) => !linked.has(record.artifact.id));
  if (unlinked.length === 0) return null;
  return (
    <section className="artifacts-panel" aria-label="Session artifacts">
      {unlinked.map((record) => {
        const request =
          artifacts.request?.record.artifact.id === record.artifact.id
            ? artifacts.request
            : undefined;
        return (
          <ArtifactHost
            key={record.artifact.id}
            record={record}
            requested={Boolean(request)}
            onSubmit={(value) => void artifacts.answer(record, value)}
            onSkip={() => void artifacts.respond(undefined, true)}
            inlineWidgets={inlineWidgets}
          />
        );
      })}
    </section>
  );
});

function UiDialog({
  request,
  extensionUi,
}: {
  request: UiRequestState;
  extensionUi: ExtensionUiStore;
}) {
  const [value, setValue] = useState(
    request.kind === "confirm" ? "true" : (request.initialValue ?? ""),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void extensionUi.respond(value);
  };
  return (
    <Confirmation
      state="requested"
      role="alertdialog"
      aria-labelledby="ui-title"
      aria-describedby="ui-message"
    >
      <ConfirmationRequest>
        <form onSubmit={submit}>
          <ConfirmationTitle id="ui-title">{request.title}</ConfirmationTitle>
          <ConfirmationDescription id="ui-message">{request.message}</ConfirmationDescription>
          {request.kind === "select" ? (
            <select
              className="dialog-field"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required
            >
              <option value="">Select…</option>
              {request.options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : request.multiline ? (
            <textarea
              className="dialog-field dialog-editor"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              autoFocus
            />
          ) : request.kind !== "confirm" ? (
            <input
              className="dialog-field"
              type={request.kind === "secret" ? "password" : "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={request.placeholder}
              autoFocus
            />
          ) : null}
          <ConfirmationActions>
            <ConfirmationAction
              variant="outline"
              onClick={() => void extensionUi.respond(undefined, true)}
            >
              Cancel
            </ConfirmationAction>
            {request.kind === "confirm" && (
              <ConfirmationAction
                variant="outline"
                onClick={() => void extensionUi.respond("false")}
              >
                Decline
              </ConfirmationAction>
            )}
            <ConfirmationAction type="submit">
              {request.kind === "confirm" ? "Confirm" : "Continue"}
            </ConfirmationAction>
          </ConfirmationActions>
        </form>
      </ConfirmationRequest>
    </Confirmation>
  );
}

export const Sidebar = observer(function Sidebar({
  store,
  projects,
  chat,
  cakeChat,
  shell,
  onOpenSettings,
  onOpenCakeChat,
  onCreateCakeChat,
  onOpenSession,
  onCreateSession,
  onChooseProject,
  onToggle,
}: {
  store: SidebarStore;
  projects: ProjectCatalogStore;
  chat: ProjectWorkbenchStore;
  cakeChat: GlobalChatStore;
  shell: AppShellStore;
  onOpenSettings: () => void;
  onOpenCakeChat(sessionId?: string): void;
  onCreateCakeChat(): void;
  onOpenSession(sessionId: string): void;
  onCreateSession(workspacePath: string): void;
  onChooseProject(): void;
  onToggle: () => void;
}) {
  const projectPaths = projects.orderedProjectPaths;
  return (
    <aside className="sidebar">
      <div className="sidebar-window-tools">
        <IconButton tooltip="Toggle sidebar" onClick={onToggle}>
          <SidebarIcon />
        </IconButton>
        <IconButton tooltip="Back" disabled>
          <BackIcon />
        </IconButton>
        <IconButton tooltip="Forward" disabled>
          <ForwardIcon />
        </IconButton>
      </div>
      <div className="plugin-slot plugin-slot-sidebar-header">
        <Slot name="global.sidebar.header" />
      </div>
      <div className="sidebar-scroll">
        <SidebarCakeChatGroup
          store={store}
          cakeChat={cakeChat}
          shell={shell}
          resolved={false}
          onOpenCakeChat={onOpenCakeChat}
          onCreateCakeChat={onCreateCakeChat}
        />
        <div className="section-heading projects-heading">
          <span>Projects</span>
          <div>
            <IconButton tooltip="Add project" onClick={onChooseProject}>
              <PlusIcon />
            </IconButton>
          </div>
        </div>
        {projectPaths.length === 0 ? (
          <p className="sidebar-empty">Add a folder to start a project.</p>
        ) : (
          projectPaths.map((path) => (
            <SidebarProjectGroup
              key={path}
              store={store}
              projects={projects}
              chat={chat}
              shell={shell}
              path={path}
              resolved={false}
              onCreateSession={onCreateSession}
              onOpenSession={onOpenSession}
            />
          ))
        )}
        {store.hasResolvedSessions && (
          <section className="resolved-lane" aria-labelledby="resolved-lane-heading">
            <div className="section-heading lane-heading" id="resolved-lane-heading">
              <button
                className="lane-toggle"
                type="button"
                aria-expanded={store.resolvedLaneExpanded}
                aria-controls="resolved-lane-content"
                aria-label={`${store.resolvedLaneExpanded ? "Collapse" : "Expand"} Resolved`}
                onClick={() => store.toggleResolvedLane()}
              >
                <span
                  className={`lane-disclosure ${store.resolvedLaneExpanded ? "" : "collapsed"}`}
                >
                  <ChevronIcon />
                </span>
                <span>Resolved</span>
              </button>
            </div>
            {store.resolvedLaneExpanded && (
              <div id="resolved-lane-content" className="resolved-lane-content">
                <SidebarCakeChatGroup
                  store={store}
                  cakeChat={cakeChat}
                  shell={shell}
                  resolved={true}
                  onOpenCakeChat={onOpenCakeChat}
                  onCreateCakeChat={onCreateCakeChat}
                />
                {projectPaths.map((path) => (
                  <SidebarProjectGroup
                    key={`resolved:${path}`}
                    store={store}
                    projects={projects}
                    chat={chat}
                    shell={shell}
                    path={path}
                    resolved={true}
                    onCreateSession={onCreateSession}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="plugin-slot plugin-slot-sidebar-footer">
          <Slot name="global.sidebar.footer" />
        </div>
        <IconButton
          className={
            shell.selection.kind === "settings"
              ? "sidebar-settings-icon active"
              : "sidebar-settings-icon"
          }
          tooltip="Open settings"
          aria-current={shell.selection.kind === "settings" ? "page" : undefined}
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </IconButton>
      </div>
    </aside>
  );
});

export const App = observer(function App() {
  const root = useStore(RootStore);
  const subscribeToChatAboutSelection = useCallback(
    (listener: () => void) =>
      root.client.subscribe((event) => {
        if (event.type === "context-menu-action" && event.action === "chat-about-selection")
          listener();
      }),
    [root.client],
  );
  const store = root.projectWorkbenchStore;
  const sidebar = root.sidebarStore;
  const projects = root.projectCatalogStore;
  const persistence = root.windowPersistence;
  const browse = store.browseStore;
  const changes = store.changesStore;
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
    window.innerWidth - (store.commandPane ? commandPaneWidth : 0) - 360,
  );
  const commandPaneMax = Math.max(
    320,
    window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth) - 360,
  );
  const returnToWorkbench = useCallback(() => {
    root.showWorkbench();
    store.activeSession?.composerStore.requestFocus();
  }, [root, store]);
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
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [settings.theme]);
  useEffect(() => {
    document.title = extensionUi.title ? `${extensionUi.title} · Cake` : "Cake";
  }, [extensionUi.title]);
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (browse.path !== undefined || changes.path !== undefined) returnToWorkbench();
      else if (store.commandPane) store.closeCommandPane();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [store, browse, changes, returnToWorkbench]);

  if (!persistence.hydrated)
    return (
      <main className="loading-screen">
        <span className="cake-mark">C</span>
        <LoadingState label="Restoring Cake" />
      </main>
    );
  if (changes.path !== undefined)
    return (
      <ChangeExplorer
        store={changes}
        reviews={reviews}
        browse={browse}
        chat={store}
        onClose={returnToWorkbench}
      />
    );
  if (browse.path !== undefined)
    return (
      <WorkspaceBrowser store={browse} reviews={reviews} chat={store} onClose={returnToWorkbench} />
    );

  const shellStyle: CSSProperties & Record<"--sidebar-width" | "--right-pane-width", string> = {
    "--sidebar-width": `${Math.min(sidebarWidth, sidebarMax)}px`,
    "--right-pane-width": `${Math.min(commandPaneWidth, commandPaneMax)}px`,
  };
  return (
    <main
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${store.commandPane ? "right-pane-open" : ""} ${resizingPanel ? "is-resizing" : ""}`}
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
                        store.requestCreateWorktreeSession(projectPath);
                      }}
                      onFinished={(projectPath) => {
                        void root.createSession(projectPath);
                      }}
                      notify={root.toastStore.show}
                    />
                    <button
                      className="header-pane-toggle"
                      type="button"
                      aria-label="Browse project files"
                      onClick={() => void store.openWorkspaceBrowser()}
                    >
                      <BrowseIcon />
                      <span>Browse</span>
                    </button>
                    <button
                      className={`header-pane-toggle${store.commandPane === "tree" ? " active" : ""}`}
                      type="button"
                      aria-label="Session tree"
                      aria-pressed={store.commandPane === "tree"}
                      onClick={() => store.toggleCommandPane("tree")}
                    >
                      <TreeIcon />
                      <span>Tree</span>
                    </button>
                    <button
                      className="header-pane-toggle"
                      type="button"
                      aria-label="Open workspace changes"
                      onClick={() => void store.openSessionChanges()}
                    >
                      <ChangesIcon />
                      <span>Changes</span>
                      {changes.workingTreeCount > 0 && <b>{changes.workingTreeCount}</b>}
                    </button>
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
                transcriptBehavior={{
                  onFork: (entryId) => {
                    void store.forkAt(entryId);
                  },
                  openFileInEditor: (path) => root.openFileInEditor(session.workspacePath, path),
                  openFilePath: (path) => {
                    void store
                      .openWorkspaceBrowser(toWorkspaceRelativePath(path, session.workspacePath))
                      .catch(() => undefined);
                  },
                  onOpenReviewRun: (threadId) => {
                    void store.openSessionChanges(threadId);
                  },
                  waitingForUser: Boolean(extensionUi.request || artifactInteractions?.request),
                  messageComments: session.messageCommentsStore,
                  subscribeToChatAboutSelection,
                  inlineWidgets: root.inlineWidgetStore,
                  artifacts: {
                    records: session.model.artifacts.map((artifact) => artifact.value),
                    interaction: session.artifactInteractionStore,
                  },
                }}
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
                    <ArtifactsPanel session={session} inlineWidgets={root.inlineWidgetStore} />
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
      {store.commandPane && (
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
      {store.createWorktreePrompt && (
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
              {changes.workingTreeCount > 0 && (
                <ConfirmationDescription id="create-worktree-warning">
                  {changes.workingTreeCount} uncommitted change
                  {changes.workingTreeCount === 1 ? "" : "s"} in the current checkout will stay
                  behind.
                </ConfirmationDescription>
              )}
              <ConfirmationActions>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => store.cancelCreateWorktreePrompt()}
                >
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction onClick={() => void store.confirmCreateWorktreePrompt()}>
                  Create worktree
                </ConfirmationAction>
              </ConfirmationActions>
            </ConfirmationRequest>
          </Confirmation>
        </div>
      )}
      {store.forkPrompt && (
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
                  onClick={() => void store.resolveForkPrompt("cancel")}
                >
                  Cancel
                </ConfirmationAction>
                <ConfirmationAction
                  variant="outline"
                  onClick={() => void store.resolveForkPrompt("existing")}
                >
                  Use the existing worktree
                </ConfirmationAction>
                <ConfirmationAction onClick={() => void store.resolveForkPrompt("new-worktree")}>
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
