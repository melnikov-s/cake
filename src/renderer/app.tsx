import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
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
import { ContextMenu } from "@/components/ui/context-menu";
import { IconButton } from "@/components/ui/icon-button";
import { LoadingState } from "@/components/ui/loading-state";
import { ArtifactHost } from "@/components/artifact-host";
import { ChangeExplorer } from "@/components/change-explorer";
import { WorkspaceBrowser } from "@/components/workspace-browser";
import { SettingsPage } from "@/components/settings-page";
import { SessionTree } from "@/components/session-tree";
import { PanelResizeHandle } from "@/components/panel-resize-handle";
import { CopyErrorDetailsButton } from "@/components/copy-error-details-button";
import { ToastHost } from "@/components/toast-host";
import { Chat } from "@/components/chat";
import type { CompatibilityResource } from "../ipc/session-contract";
import type { ProjectWorkbenchStore } from "./stores/ProjectWorkbenchStore";
import type { ProjectSessionStore } from "./stores/ProjectSessionStore";
import type { ProjectCatalogStore } from "./stores/ProjectCatalogStore";
import type { SidebarStore } from "./stores/SidebarStore";
import { RootStore } from "./stores/RootStore";
import type { ExtensionUiStore, UiRequestState } from "./stores/ExtensionUiStore";
import type { InlineWidgetStore } from "./stores/InlineWidgetStore";
import type { GlobalChatStore } from "./stores/GlobalChatStore";
import type { AppSelection } from "./stores/AppShellStore";
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

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const FolderIcon = () => (
  <Icon>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
  </Icon>
);
const CakeIcon = () => (
  <Icon>
    <path d="M4 12.5h16v6A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M4 12.5c0-1.7 1.6-3 3.5-3s3.5 1.3 3.5 3c0-1.7 1.6-3 3.5-3s3.5 1.3 3.5 3c0-1.7 1.6-3 3.5-3" />
    <path d="M8 6v2M12 4v2M16 6v2M4 16h16" />
  </Icon>
);
const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
const ChatIcon = () => (
  <Icon>
    <path d="M20 15a3 3 0 0 1-3 3H8l-5 3 1.7-5.1A7 7 0 0 1 4 13V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
  </Icon>
);
const BackIcon = () => (
  <Icon>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);
const ForwardIcon = () => (
  <Icon>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);
const SidebarIcon = () => (
  <Icon>
    <rect x="3.5" y="4" width="17" height="16" rx="3" />
    <path d="M9 4v16" />
  </Icon>
);
const ChevronIcon = () => (
  <Icon size={13}>
    <path d="m8 10 4 4 4-4" />
  </Icon>
);
const ResolveIcon = () => (
  <Icon size={14}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12 2.25 2.25L15.8 9.2" />
  </Icon>
);
const RestoreIcon = () => (
  <Icon size={14}>
    <path d="M4.5 9A8 8 0 1 1 4 14" />
    <path d="M4.5 4.5V9H9" />
  </Icon>
);
const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.83 2.83-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21h-4v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06-2.83-2.83.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3v-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.83-2.83.06.06A1.65 1.65 0 0 0 9 4.68h.08a1.65 1.65 0 0 0 1-1.51V3h4v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06 2.83 2.83-.06.06A1.65 1.65 0 0 0 19.32 9v.08a1.65 1.65 0 0 0 1.51 1H21v4h-.09A1.65 1.65 0 0 0 19.4 15z" />
  </Icon>
);
const ChangesIcon = () => (
  <Icon size={15}>
    <path d="M4 7h10M4 17h10M17 4v6M14 7l3 3 3-3M17 14v6M14 17l3 3 3-3" />
  </Icon>
);
const BrowseIcon = () => (
  <Icon size={15}>
    <path d="M4 5.5h6l1.8 2H20v11H4z" />
    <path d="M4 9h16" />
  </Icon>
);
const compatibilityResourceKinds: CompatibilityResource["kind"][] = [
  "extension",
  "skill",
  "prompt",
  "package",
];

function CommandPane({
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
}

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
            onSubmit={(value) => void artifacts.respond(value)}
            onCancel={() => void artifacts.respond(undefined, true)}
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
  selection,
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
  selection: AppSelection;
  onOpenSettings: () => void;
  onOpenCakeChat(sessionId?: string): void;
  onCreateCakeChat(): void;
  onOpenSession(sessionId: string): void;
  onCreateSession(workspacePath: string): void;
  onChooseProject(): void;
  onToggle: () => void;
}) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [sessionMenu, setSessionMenu] = useState<{
    sessionId: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingSession, setRenamingSession] = useState<{
    sessionId: string;
    value: string;
  } | null>(null);
  const openSessionMenu = (event: React.MouseEvent, sessionId: string, title: string) => {
    event.preventDefault();
    setSessionMenu({ sessionId, title, x: event.clientX, y: event.clientY });
  };
  const commitRename = () => {
    const renaming = renamingSession;
    setRenamingSession(null);
    if (!renaming) return;
    const name = renaming.value.trim();
    if (!name) return;
    void chat.renameSession(renaming.sessionId, name);
  };
  const toggleProject = (path: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const activityIndicator = (sessionId: string) => {
    const activity = store.sessionActivity(sessionId);
    if (!activity) return null;
    const label = activity === "running" ? "Running" : "Ready, unread";
    return (
      <i
        className={`session-status session-status-${activity}`}
        role="img"
        aria-label={label}
        title={label}
      />
    );
  };
  const cakeChatSelected = (sessionId?: string) =>
    selection.kind === "cake-chat" && selection.sessionId === sessionId;
  const projectSessionSelected = (sessionId: string) =>
    selection.kind === "project-session" && selection.sessionId === sessionId;
  const renderCakeChatSession = (
    session: GlobalChatStore["summaries"][number],
    resolved: boolean,
  ) => {
    const selected = cakeChatSelected(session.id);
    const running = cakeChat.findSession(session.id)?.streaming === true;
    return (
      <div
        key={session.id}
        data-session-id={session.id}
        className={`session-item ${selected ? (running ? "active" : "active has-session-action") : ""}`}
      >
        <button
          className="session-row"
          aria-current={selected ? "page" : undefined}
          onClick={() => onOpenCakeChat(session.id)}
        >
          <span className="session-title" title={session.title}>
            {session.title}
          </span>
          {!selected && !running && (
            <time
              className="session-time"
              dateTime={session.modified}
              title={new Date(session.modified).toLocaleString()}
            >
              {store.sessionActivityTime(session.modified)}
            </time>
          )}
          {running && (
            <i
              className="session-status session-status-running"
              role="img"
              aria-label="Running"
              title="Running"
            />
          )}
        </button>
        {selected && !running && (
          <IconButton
            className="session-resolve-action"
            tooltip={resolved ? "Restore" : "Resolve"}
            ariaLabel={`${resolved ? "Restore" : "Resolve"} ${session.title}`}
            onClick={() => void store.setCakeChatSessionResolved(session.id, !resolved)}
          >
            {resolved ? <RestoreIcon /> : <ResolveIcon />}
          </IconButton>
        )}
      </div>
    );
  };
  const renderProjectGroup = (path: string, resolved: boolean) => {
    const collapsed = collapsedProjects.has(`${resolved ? "resolved" : "active"}:${path}`);
    const sessions = store.projectSessions(path, resolved);
    if (resolved && sessions.length === 0) return null;
    const visibleSessions = sessions.slice(0, store.sessionLimit(path, resolved));
    const collapseKey = `${resolved ? "resolved" : "active"}:${path}`;
    const empty = sessions.length === 0;
    return (
      <div className={`project-group ${empty ? "project-group-empty" : ""}`} key={path}>
        <div className="project-row" title={path}>
          <IconButton
            className={`project-disclosure ${collapsed ? "collapsed" : ""} ${empty ? "no-sessions" : ""}`}
            aria-expanded={!collapsed}
            tooltip={collapsed ? "Expand" : "Collapse"}
            ariaLabel={`${collapsed ? "Expand" : "Collapse"} ${projects.nameForPath(path)}${resolved ? " resolved" : ""}`}
            onClick={() => toggleProject(collapseKey)}
          >
            <ChevronIcon />
          </IconButton>
          <button
            className="project-label"
            type="button"
            aria-label={
              resolved
                ? `${collapsed ? "Expand" : "Collapse"} ${projects.nameForPath(path)} resolved`
                : `Start new chat in ${projects.nameFromPath(path)}`
            }
            onClick={() => (resolved ? toggleProject(collapseKey) : onCreateSession(path))}
          >
            <FolderIcon />
            <span>{projects.nameForPath(path)}</span>
          </button>
          {!resolved && (
            <IconButton
              className="project-add"
              tooltip="New chat"
              ariaLabel={`New chat in ${projects.nameFromPath(path)}`}
              onClick={() => onCreateSession(path)}
            >
              <PlusIcon />
            </IconButton>
          )}
        </div>
        {!collapsed &&
          visibleSessions.map((session) => {
            const selected = projectSessionSelected(session.id);
            const running = store.sessionActivity(session.id) === "running";
            return (
              <div
                key={session.id}
                data-session-id={session.id}
                className={`session-item ${selected ? (running ? "active" : "active has-session-action") : ""}`}
              >
                {renamingSession?.sessionId === session.id ? (
                  <input
                    className="session-rename-input"
                    aria-label="Session name"
                    value={renamingSession.value}
                    autoFocus
                    onChange={(event) =>
                      setRenamingSession({ sessionId: session.id, value: event.target.value })
                    }
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename();
                      else if (event.key === "Escape") setRenamingSession(null);
                    }}
                  />
                ) : (
                  <button
                    className="session-row"
                    aria-current={selected ? "page" : undefined}
                    onClick={() => onOpenSession(session.id)}
                    onContextMenu={(event) => openSessionMenu(event, session.id, session.title)}
                  >
                    <span className="session-title" title={session.title}>
                      {session.title}
                    </span>
                    {!selected && !running && (
                      <time
                        className="session-time"
                        dateTime={session.modified}
                        title={new Date(session.modified).toLocaleString()}
                      >
                        {store.sessionActivityTime(session.modified)}
                      </time>
                    )}
                    {activityIndicator(session.id)}
                  </button>
                )}
                {selected && !running && (
                  <IconButton
                    className="session-resolve-action"
                    tooltip={resolved ? "Restore" : "Resolve"}
                    ariaLabel={`${resolved ? "Restore" : "Resolve"} ${session.title}`}
                    onClick={() => void store.setSessionResolved(session.id, !resolved)}
                  >
                    {resolved ? <RestoreIcon /> : <ResolveIcon />}
                  </IconButton>
                )}
              </div>
            );
          })}
        {!collapsed && sessions.length > visibleSessions.length && (
          <button className="session-more" onClick={() => store.showMoreSessions(path, resolved)}>
            Show more
          </button>
        )}
      </div>
    );
  };
  const renderCakeChatGroup = (sessions: GlobalChatStore["summaries"], resolved: boolean) => {
    if (resolved && sessions.length === 0) return null;
    const collapseKey = `${resolved ? "resolved" : "active"}:cake-chat`;
    const collapsed = collapsedProjects.has(collapseKey);
    const empty = sessions.length === 0;
    return (
      <div
        className={`project-group cake-chat-sessions ${empty ? "project-group-empty" : ""}`}
        key={collapseKey}
      >
        <div className="project-row" title="Cake Chat">
          <IconButton
            className={`project-disclosure ${collapsed ? "collapsed" : ""} ${empty ? "no-sessions" : ""}`}
            aria-expanded={!collapsed}
            tooltip={collapsed ? "Expand" : "Collapse"}
            ariaLabel={`${collapsed ? "Expand" : "Collapse"} Cake Chat${resolved ? " resolved" : ""}`}
            onClick={() => toggleProject(collapseKey)}
          >
            <ChevronIcon />
          </IconButton>
          <button
            className="project-label"
            type="button"
            aria-label={
              resolved
                ? `${collapsed ? "Expand" : "Collapse"} Cake Chat resolved`
                : "Open Cake Chat"
            }
            onClick={() => (resolved ? toggleProject(collapseKey) : onOpenCakeChat())}
          >
            <CakeIcon />
            <span>Cake Chat</span>
          </button>
          {!resolved && (
            <IconButton className="project-add" tooltip="New Cake Chat" onClick={onCreateCakeChat}>
              <PlusIcon />
            </IconButton>
          )}
        </div>
        {!collapsed && sessions.map((session) => renderCakeChatSession(session, resolved))}
      </div>
    );
  };
  const activeCakeChats = store.cakeChatSessions();
  const resolvedCakeChats = store.cakeChatSessions(true);
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
        {renderCakeChatGroup(activeCakeChats, false)}
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
          projectPaths.map((path) => renderProjectGroup(path, false))
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
                {renderCakeChatGroup(resolvedCakeChats, true)}
                {projectPaths.map((path) => renderProjectGroup(path, true))}
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
            selection.kind === "settings" ? "sidebar-settings-icon active" : "sidebar-settings-icon"
          }
          tooltip="Open settings"
          aria-current={selection.kind === "settings" ? "page" : undefined}
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </IconButton>
      </div>
      {sessionMenu && (
        <ContextMenu
          position={{ x: sessionMenu.x, y: sessionMenu.y }}
          items={[
            {
              id: "rename",
              label: "Rename",
              onSelect: () => {
                setRenamingSession({ sessionId: sessionMenu.sessionId, value: sessionMenu.title });
              },
            },
            {
              id: "copy-session-id",
              label: "Copy Session ID",
              onSelect: () => {
                void navigator.clipboard.writeText(sessionMenu.sessionId);
              },
            },
          ]}
          onClose={() => setSessionMenu(null)}
        />
      )}
    </aside>
  );
});

export const App = observer(function App() {
  const root = useStore(RootStore);
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
        selection={shell.selection}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onOpenSettings={() => root.showSettings()}
        onOpenCakeChat={(sessionId) => {
          void root.openCakeChat(sessionId);
        }}
        onCreateCakeChat={() => {
          void root.startCakeChat();
        }}
        onOpenSession={(sessionId) => {
          void root.openSession(sessionId);
        }}
        onCreateSession={(workspacePath) => {
          void root.createSession(workspacePath);
        }}
        onChooseProject={() => {
          void root.chooseProject();
        }}
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
                      className="header-pane-toggle"
                      type="button"
                      aria-label="Open workspace changes"
                      onClick={() => void store.openSessionChanges()}
                    >
                      <ChangesIcon />
                      <span>Changes</span>
                      {changes.workingTreeCount > 0 && <b>{changes.workingTreeCount}</b>}
                    </button>
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
                  onOpenReviewRun: (threadId) => {
                    void store.openSessionChanges(threadId);
                  },
                  waitingForUser: Boolean(extensionUi.request || artifactInteractions?.request),
                  messageComments: session.messageCommentsStore,
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
