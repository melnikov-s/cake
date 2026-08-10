import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle
} from "@/components/ai-elements/confirmation";
import { Composer, ComposerToolbar } from "@/components/ai-elements/composer";
import { Conversation, VirtualizedConversation, type VirtualizedConversationHandle } from "@/components/ai-elements/conversation";
import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageContent, MessageLabel } from "@/components/ai-elements/message";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Source } from "@/components/ai-elements/source";
import { Tool } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { ArtifactHost, downloadArtifactMarkdown } from "@/components/artifact-host";
import { ModelCombobox } from "@/components/model-combobox";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import type { CompatibilityResource, SessionTreeNode, UiPart } from "../ipc/session-contract";
import { WindowStore, type UiRequestState } from "./stores/window-store";

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

const FolderIcon = () => <Icon><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" /></Icon>;
const PlusIcon = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>;
const ChatIcon = () => <Icon><path d="M20 15a3 3 0 0 1-3 3H8l-5 3 1.7-5.1A7 7 0 0 1 4 13V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" /></Icon>;
const SearchIcon = () => <Icon><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></Icon>;
const CloseIcon = () => <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>;
const PaperclipIcon = () => <Icon><path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9" /></Icon>;
const SendIcon = () => <Icon><path d="m5 12 7-7 7 7M12 19V5" /></Icon>;
const SettingsIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></Icon>;
const BackIcon = () => <Icon><path d="m15 18-6-6 6-6" /></Icon>;

function SessionTree({ nodes, store }: { nodes: SessionTreeNode[]; store: WindowStore }) {
  return <ul className="session-tree">{nodes.map((node) => <li key={node.id} className={node.active ? "active" : ""}><div><button onClick={() => void store.navigateTo(node.id)}>{node.label || node.preview || node.type}</button><button title="Fork from here" onClick={() => void store.forkAt(node.id)}>Fork</button></div>{node.children.length > 0 && <SessionTree nodes={node.children} store={store} />}</li>)}</ul>;
}

function CommandPane({ store }: { store: WindowStore }) {
  if (!store.commandPane || !store.session) return null;
  const title = store.commandPane === "tree" ? "Session tree" : store.commandPane === "changes" ? "Changed files" : "Pi resources";
  const resourceGroups = store.commandPane === "resources"
    ? (["extension", "skill", "prompt", "package"] as CompatibilityResource["kind"][]).map((kind) => ({ kind, resources: store.session!.compatibility.resources.filter((item) => item.kind === kind) }))
    : [];
  const diagnostics = store.commandPane === "resources"
    ? [...new Map([...store.session.compatibility.diagnostics, ...store.compatibilityDiagnostics].map((item) => [item.id, item])).values()]
    : [];
  return (
    <div className="command-pane-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) store.closeCommandPane(); }}>
      <section className="command-pane secondary-surface" role="dialog" aria-modal="true" aria-labelledby="command-pane-title">
        <header><div><h2 id="command-pane-title">{title}</h2>{store.commandPane === "tree" && <span>Navigate or fork without rewriting Pi history</span>}</div><div>{store.commandPane === "changes" && <Button variant="outline" size="sm" onClick={() => void store.refreshChanges()}>Refresh</Button>}<Button variant="ghost" size="sm" aria-label={`Close ${title}`} onClick={() => store.closeCommandPane()}>Close</Button></div></header>
        {store.commandPane === "tree"
          ? store.session.tree.length > 0 ? <SessionTree nodes={store.session.tree} store={store} /> : <p>This session has no branches yet.</p>
          : store.commandPane === "changes"
            ? store.changesLoading ? <p>Loading changes…</p> : store.changedFiles.length === 0 ? <p>No changed files.</p> : store.changedFiles.map((file) => <details key={`${file.staged}-${file.path}`}><summary><code>{file.status}</code> {file.path}<span>+{file.additions} −{file.deletions}</span></summary><pre>{file.diff || "Diff unavailable for this file."}</pre></details>)
            : <div className="resource-catalog">{diagnostics.length > 0 && <section className="resource-diagnostics"><h3>Diagnostics</h3>{diagnostics.map((item) => <div key={item.id} className={`notice notice-${item.severity}`}><strong>{item.method ?? item.source}</strong><span>{item.message}{item.path ? `\n${item.path}` : ""}</span></div>)}</section>}{resourceGroups.map((group) => <section key={group.kind}><h3>{group.kind[0]!.toUpperCase() + group.kind.slice(1)}s <span>{group.resources.length}</span></h3>{group.resources.length === 0 ? <p>None discovered.</p> : group.resources.map((resource) => <article key={resource.id}><div><strong>{resource.name}</strong><small>{resource.scope} · {resource.origin}</small></div>{resource.description && <p>{resource.description}</p>}{resource.commands.length > 0 && <p><b>Commands</b> {resource.commands.map((command) => `/${command}`).join(", ")}</p>}{resource.tools.length > 0 && <p><b>Tools</b> {resource.tools.join(", ")}</p>}<code title={resource.path}>{resource.source}</code></article>)}</section>)}</div>}
      </section>
    </div>
  );
}

function TranscriptPart({ part, store }: { part: UiPart; store: WindowStore }) {
  if (part.kind === "text") {
    return (
      <Message className={part.role === "user" ? "ml-auto w-[min(88%,42rem)]" : "mr-auto w-full"}>
        <MessageLabel>{part.role === "user" ? "You" : part.status === "streaming" ? "Cake · working" : "Cake"}</MessageLabel>
        <MessageContent className={part.role === "user" ? "user-message" : undefined}><Markdown>{part.text}</Markdown></MessageContent>
      </Message>
    );
  }
  if (part.kind === "reasoning") return <Reasoning open={store.thinkingExpanded} onToggle={() => store.toggleThinking()} streaming={part.status === "streaming"}><Markdown>{part.text}</Markdown></Reasoning>;
  if (part.kind === "tool") return <Tool part={part} />;
  if (part.kind === "source") return <Source title={part.title} url={part.url} />;
  if (part.kind === "attachment") return <div className="w-fit rounded-full border border-border px-3 py-1 font-mono text-[0.68rem]">{part.attachmentKind} · {part.name}</div>;
  return <div className={`notice notice-${part.tone}`} role={part.tone === "error" ? "alert" : "status"}><strong>{part.title}</strong>{part.detail && <span>{part.detail}</span>}</div>;
}

type TranscriptItem = UiPart | { kind: "activity-group"; id: string; parts: UiPart[] };

function groupTranscriptParts(parts: UiPart[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let activity: UiPart[] = [];
  const flush = () => {
    if (activity.length === 0) return;
    items.push({ kind: "activity-group", id: `activity-${activity[0]!.id}`, parts: activity });
    activity = [];
  };
  for (const part of parts) {
    if (part.kind === "tool" || part.kind === "reasoning") activity.push(part);
    else {
      flush();
      items.push(part);
    }
  }
  flush();
  return items;
}

function ActivityGroup({ parts, store }: { parts: UiPart[]; store: WindowStore }) {
  const tools = parts.filter((part) => part.kind === "tool").length;
  const label = tools === 0 ? "Reasoning" : `${tools} tool ${tools === 1 ? "call" : "calls"}`;
  return (
    <details className="activity-group" open={store.isStreaming || undefined}>
      <summary><span className={store.isStreaming ? "activity-pulse" : ""} />Work log <small>{label}</small></summary>
      <div>{parts.map((part) => <TranscriptPart key={part.id} part={part} store={store} />)}</div>
    </details>
  );
}

const TranscriptList = forwardRef<HTMLDivElement, ComponentProps<"div">>(function TranscriptList({ className, ...props }, ref) {
  return <div ref={ref} className={`transcript-list ${className ?? ""}`} aria-label="Conversation" {...props} />;
});

export const Transcript = observer(function Transcript({ store, sessionId }: { store: WindowStore; sessionId: string }) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const items = groupTranscriptParts(store.parts);
  const latestUserPartId = store.parts.findLast((part) => part.kind === "text" && part.role === "user")?.id;
  const itemCountRef = useRef(items.length);
  itemCountRef.current = items.length;

  const scrollToLatest = useCallback(() => {
    if (itemCountRef.current === 0) return;
    virtuosoRef.current?.scrollToIndex({ index: itemCountRef.current - 1, align: "end", behavior: "auto" });
  }, []);

  useLayoutEffect(() => {
    scrollToLatest();
  }, [sessionId, scrollToLatest]);

  useEffect(() => {
    if (!latestUserPartId) return;
    scrollToLatest();
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [latestUserPartId, scrollToLatest]);

  if (items.length === 0) {
    return (
      <div className="transcript transcript-empty">
        <Conversation><div className="chat-empty"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build in <em>{store.projectName}</em>?</h1><p>Describe a task, ask a question, or type <code>/</code> for commands.</p></div><ArtifactsPanel store={store} />{store.error && <div className="notice notice-error" role="alert"><strong>Operation failed</strong><span>{store.error}</span></div>}</Conversation>
      </div>
    );
  }

  return (
    <VirtualizedConversation
      ref={virtuosoRef}
      className="transcript"
      data={items}
      computeItemKey={(_index, item) => item.id}
      initialTopMostItemIndex={{ index: items.length - 1, align: "end" }}
      followOutput={(isAtBottom) => isAtBottom ? "auto" : false}
      components={{
        List: TranscriptList,
        Footer: () => <div className="transcript-footer"><ArtifactsPanel store={store} />{store.error && <div className="notice notice-error" role="alert"><strong>Operation failed</strong><span>{store.error}</span></div>}</div>
      }}
      itemContent={(_index, item) => <div className="transcript-item">{item.kind === "activity-group" ? <ActivityGroup parts={item.parts} store={store} /> : <TranscriptPart part={item} store={store} />}</div>}
    />
  );
});

const ArtifactsPanel = observer(function ArtifactsPanel({ store }: { store: WindowStore }) {
  if (store.artifacts.length === 0) return null;
  return <section className="artifacts-panel" aria-label="Session artifacts"><header><strong>Artifacts</strong><Button variant="ghost" size="sm" onClick={() => { void store.exportArtifacts().then(downloadArtifactMarkdown); }}>Export Markdown</Button></header>{store.artifacts.map((record) => { const request = store.artifactRequest?.record.artifact.id === record.artifact.id ? store.artifactRequest : undefined; return <ArtifactHost key={record.artifact.id} record={record} requested={Boolean(request)} onSubmit={(value) => void store.respondToArtifact(value)} onCancel={() => void store.respondToArtifact(undefined, true)} />; })}</section>;
});

function UiDialog({ request, store }: { request: UiRequestState; store: WindowStore }) {
  const [value, setValue] = useState(request.kind === "confirm" ? "true" : request.initialValue ?? "");
  const submit = (event: FormEvent) => { event.preventDefault(); void store.respondToUi(value); };
  return (
    <Confirmation state="requested" role="alertdialog" aria-labelledby="ui-title" aria-describedby="ui-message">
      <ConfirmationRequest><form onSubmit={submit}>
        <ConfirmationTitle id="ui-title">{request.title}</ConfirmationTitle>
        <ConfirmationDescription id="ui-message">{request.message}</ConfirmationDescription>
        {request.kind === "select" ? (
          <select className="dialog-field" value={value} onChange={(event) => setValue(event.target.value)} required><option value="">Select…</option>{request.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        ) : request.multiline ? (
          <textarea className="dialog-field dialog-editor" value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} autoFocus />
        ) : request.kind !== "confirm" ? (
          <input className="dialog-field" type={request.kind === "secret" ? "password" : "text"} value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} autoFocus />
        ) : null}
        <ConfirmationActions><ConfirmationAction variant="outline" onClick={() => void store.respondToUi(undefined, true)}>Cancel</ConfirmationAction>{request.kind === "confirm" && <ConfirmationAction variant="outline" onClick={() => void store.respondToUi("false")}>Decline</ConfirmationAction>}<ConfirmationAction type="submit">{request.kind === "confirm" ? "Confirm" : "Continue"}</ConfirmationAction></ConfirmationActions>
      </form></ConfirmationRequest>
    </Confirmation>
  );
}

const Sidebar = observer(function Sidebar({ store, onOpenSettings, onOpenChat, settingsOpen }: { store: WindowStore; onOpenSettings: () => void; onOpenChat: () => void; settingsOpen: boolean }) {
  const [searchExpanded, setSearchExpanded] = useState(Boolean(store.sessionSearch));
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (store.sessionSearch) setSearchExpanded(true);
  }, [store.sessionSearch]);
  useEffect(() => {
    if (!searchExpanded) return;
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchExpanded]);
  const closeSearch = () => {
    store.setSessionSearch("");
    setSearchExpanded(false);
  };
  const navigateToChat = (action: () => void | Promise<unknown>) => {
    onOpenChat();
    void action();
  };
  const renameSession = (event: React.MouseEvent, workspacePath: string, sessionId: string, title: string) => {
    event.preventDefault();
    const name = window.prompt("Session name", title);
    if (name) void store.renameSession(workspacePath, sessionId, name);
  };
  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="cake-mark">C</span><span>Cake</span><span className={`status-dot status-${store.piState}`} title={`Pi ${store.piState}`} /></div>
      <div className="sidebar-scroll">
        <div className="section-heading"><span>Sessions</span><div><button className={searchExpanded ? "search-trigger active" : "search-trigger"} aria-label={searchExpanded ? "Close session search" : "Search sessions"} aria-expanded={searchExpanded} onClick={() => searchExpanded ? closeSearch() : setSearchExpanded(true)}>{searchExpanded ? <CloseIcon /> : <SearchIcon />}</button></div></div>
        <button className="new-chat" onClick={() => navigateToChat(() => store.startOneOffChat())}><ChatIcon /><span>New chat</span><kbd>⌘N</kbd></button>
        <div className={`session-filter global-session-filter ${searchExpanded ? "expanded" : ""}`} aria-hidden={!searchExpanded}><input ref={searchInput} aria-label="Search sessions" placeholder="Search all sessions" value={store.sessionSearch} disabled={!searchExpanded} onChange={(event) => store.setSessionSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }} /></div>
        {store.sessionSearch.trim() && <div className="global-session-results">
          {store.searchedSessions.length === 0 ? <p className="sidebar-empty">No matching sessions.</p> : store.searchedSessions.slice(0, 50).map((session) => <div key={`${session.workspacePath}:${session.id}`} data-session-id={session.id} className={`session-item ${session.id === store.session?.sessionId && session.workspacePath === store.projectPath ? "active" : ""}`}><button className="session-row global-session-row" aria-current={session.id === store.session?.sessionId && session.workspacePath === store.projectPath ? "page" : undefined} onClick={() => navigateToChat(() => store.openSession(session.workspacePath, session.id))} onContextMenu={(event) => renameSession(event, session.workspacePath, session.id, session.title)}><span>{session.title}</span><small>{session.workspaceName}</small></button></div>)}
        </div>}
        <div className="section-heading"><span>Projects</span><div><button aria-label="Add project" onClick={() => navigateToChat(() => store.chooseProject())}><PlusIcon /></button></div></div>
        {store.recentProjectPaths.length === 0 ? <p className="sidebar-empty">Add a folder to start a project.</p> : store.recentProjectPaths.map((path) => {
          const active = path === store.projectPath;
          const sessions = store.projectSessions(path);
          const visibleSessions = sessions.slice(0, store.sessionLimit(path));
          return <div className="project-group" key={path}>
            <div className={`project-row ${active ? "active" : ""}`}><button className="project-open" title={path} onClick={() => navigateToChat(() => store.switchProject(path))}><FolderIcon /><span>{store.projects.find((item) => item.path === path)?.name ?? store.nameFromPath(path)}</span></button>{active && <button className="project-add" aria-label={`New chat in ${store.nameFromPath(path)}`} onClick={() => navigateToChat(() => store.startNewSession())}><PlusIcon /></button>}</div>
            {!store.sessionSearch.trim() && visibleSessions.map((session) => <div key={session.id} data-session-id={session.id} className={`session-item ${session.id === store.session?.sessionId && path === store.projectPath ? "active" : ""}`}><button className="session-row" aria-current={session.id === store.session?.sessionId && path === store.projectPath ? "page" : undefined} onClick={() => navigateToChat(() => store.openSession(path, session.id))} onContextMenu={(event) => renameSession(event, path, session.id, session.title)}><span>{session.title}</span>{session.id === store.session?.sessionId && path === store.projectPath && store.isStreaming && <i />}</button></div>)}
            {!store.sessionSearch.trim() && sessions.length > visibleSessions.length && <button className="session-more" onClick={() => store.showMoreSessions(path)}>More <span>{sessions.length - visibleSessions.length}</span></button>}
          </div>;
        })}
      </div>
      <div className="sidebar-footer">
        <button className={settingsOpen ? "sidebar-settings active" : "sidebar-settings"} type="button" aria-label="Open settings" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings}><SettingsIcon /></button>
      </div>
    </aside>
  );
});

const ComposerPanel = observer(function ComposerPanel({ store }: { store: WindowStore }) {
  const selectedModel = store.session?.model;
  return (
    <div className="composer-dock">
      {store.extensionWidgets.filter((widget) => widget.placement === "aboveEditor").map((widget) => <div className="legacy-widget" key={widget.key}><strong>{widget.key}</strong><pre>{widget.lines.join("\n")}</pre></div>)}
      <Composer className="workbench-composer" onSubmit={(event) => { event.preventDefault(); void store.submit(); }}>
        {store.attachments.length > 0 && <div className="attachment-list">{store.attachments.map((attachment, index) => <button type="button" key={`${attachment.kind}-${attachment.name}`} onClick={() => store.removeAttachment(index)}>{attachment.kind === "file" ? "@" : "▧"} {attachment.name} <span>×</span></button>)}</div>}
        <SlashCommandCombobox aria-label="Message" commands={store.session?.commands ?? []} placeholder={store.isStreaming ? "Add the next instruction…" : `Ask Cake to work in ${store.projectName}…`} value={store.draft} onValueChange={(value) => store.setDraft(value)} onSubmit={() => void store.submit()} />
        <ComposerToolbar className="composer-toolbar">
          <div className="composer-context">
            <button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={() => void store.addAttachments()}><PaperclipIcon /></button>
            <ModelCombobox ariaLabel="Model" groups={store.modelsByProvider} value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onSelect={(value) => void store.selectModel(value)} />
            <select aria-label="Thinking level" value={store.session?.thinkingLevel} onChange={(event) => void store.selectThinkingLevel(event.target.value as NonNullable<typeof store.session>["thinkingLevel"])}>{store.session?.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "No reasoning" : `${level.charAt(0).toUpperCase()}${level.slice(1)} reasoning`}</option>)}</select>
          </div>
          <div className="composer-actions">
            {store.isStreaming && <><Button variant="ghost" size="sm" type="button" onClick={() => void store.abort()}>Stop</Button><Button variant="outline" size="sm" type="button" disabled={!store.canSubmit} onClick={() => void store.submit("steer")}>Steer</Button></>}
            <Button className="send-button" size="sm" type="submit" disabled={!store.canSubmit}>{store.isStreaming ? "Queue" : "Send"}<SendIcon /></Button>
          </div>
        </ComposerToolbar>
      </Composer>
      {store.extensionWidgets.filter((widget) => widget.placement === "belowEditor").map((widget) => <div className="legacy-widget" key={widget.key}><strong>{widget.key}</strong><pre>{widget.lines.join("\n")}</pre></div>)}
      {store.extensionStatuses.length > 0 && <div className="extension-statuses" role="status">{store.extensionStatuses.map((status) => <span key={status.key}><strong>{status.key}</strong> {status.text}</span>)}</div>}
    </div>
  );
});

export const SettingsPage = observer(function SettingsPage({ store }: { store: WindowStore }) {
  const selectedModel = store.session?.model;
  return (
    <div className="settings-page">
      <div className="settings-intro">
        <span className="settings-kicker">Cake / Pi</span>
        <h1>Settings</h1>
        <p>Choose how Pi works in this chat and manage the providers it can use.</p>
      </div>

      <section className="settings-section" aria-labelledby="pi-settings-title">
        <header><div><h2 id="pi-settings-title">Pi</h2><p>Model and reasoning changes apply to the current chat.</p></div><span className={`settings-runtime status-${store.piState}`}><i />{store.piState}</span></header>
        {store.session ? <div className="settings-fields">
          <div className="settings-field"><span>Model<small>The model Pi uses for its next response.</small></span><ModelCombobox ariaLabel="Settings model" groups={store.modelsByProvider} value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onSelect={(value) => void store.selectModel(value)} variant="settings" /></div>
          <label><span>Reasoning<small>Controls how much time Pi spends thinking.</small></span><select aria-label="Settings thinking level" value={store.session.thinkingLevel} onChange={(event) => void store.selectThinkingLevel(event.target.value as NonNullable<typeof store.session>["thinkingLevel"])}>{store.session.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "Off" : level.charAt(0).toUpperCase() + level.slice(1)}</option>)}</select></label>
        </div> : <p className="settings-empty">Open a project or start a one-off chat to choose a model and reasoning level.</p>}
      </section>

      <section className="settings-section" aria-labelledby="providers-title">
        <header><div><h2 id="providers-title">Providers</h2><p>Connect the accounts and API keys that make models available to Pi.</p></div></header>
        {store.modelsByProvider.length === 0 ? <p className="settings-empty">Provider details will appear after a chat is open.</p> : <div className="provider-list">{store.modelsByProvider.map((provider) => {
          const authenticated = provider.models.some((model) => model.authenticated);
          const authTypes = [...new Set(provider.models.flatMap((model) => model.authTypes))];
          return <article className="provider-row" key={provider.id}><div className="provider-identity"><span className="provider-monogram">{provider.name.slice(0, 1).toUpperCase()}</span><span><strong>{provider.name}</strong><small>{provider.models.length} {provider.models.length === 1 ? "model" : "models"}</small></span></div><span className={authenticated ? "provider-state connected" : "provider-state"}><i />{authenticated ? "Connected" : "Not connected"}</span><div className="provider-actions">{authenticated ? <Button variant="outline" size="sm" type="button" onClick={() => void store.logout(provider.id)}>Disconnect</Button> : authTypes.map((authType) => <Button key={authType} variant={authType === "oauth" ? "default" : "outline"} size="sm" type="button" onClick={() => void store.authenticate(provider.id, authType)}>{authType === "oauth" ? "Connect" : "Add API key"}</Button>)}</div></article>;
        })}</div>}
      </section>

      <section className="settings-section" aria-labelledby="appearance-title">
        <header><div><h2 id="appearance-title">Appearance</h2><p>Choose how Cake looks on this device.</p></div></header>
        <div className="settings-fields"><label><span>Theme<small>Follow your system or use a fixed appearance.</small></span><select aria-label="Color theme" value={store.theme} onChange={(event) => store.setTheme(event.target.value as typeof store.theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
      </section>
    </div>
  );
});

export const App = observer(function App() {
  const store = useStore(WindowStore);
  const [page, setPage] = useState<"chat" | "settings">("chat");
  useEffect(() => {
    document.documentElement.dataset.theme = store.theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [store.theme]);
  useEffect(() => {
    document.title = store.extensionTitle ? `${store.extensionTitle} · Cake` : "Cake";
  }, [store.extensionTitle]);
  useEffect(() => {
    if (!store.commandPane) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") store.closeCommandPane(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [store, store.commandPane]);

  if (!store.hydrated) return <main className="loading-screen"><span className="cake-mark">C</span><p>Restoring Cake…</p></main>;

  return (
    <main className="app-shell">
      <Sidebar store={store} settingsOpen={page === "settings"} onOpenSettings={() => setPage("settings")} onOpenChat={() => setPage("chat")} />
      <section className="workspace" data-session-id={store.session?.sessionId}>
        <header className="workspace-header"><div>{page === "settings" && <button className="header-back" aria-label="Back to chat" onClick={() => setPage("chat")}><BackIcon /></button>}<strong>{page === "settings" ? "Settings" : store.extensionTitle ?? (store.session ? (store.session.sessions.find((item) => item.id === store.session?.sessionId)?.title || "New chat") : "Cake")}</strong>{page === "chat" && store.projectPath && <span>{store.projectPath}</span>}</div></header>
        {page === "settings" ? <SettingsPage store={store} /> : !store.session ? (
          <div className="welcome"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build?</h1><p>Open a project for durable workspace chats, or start a one-off chat from your home directory.</p><div><Button size="lg" disabled={store.piState !== "ready" || store.isBusy} onClick={() => void store.chooseProject()}><FolderIcon /> Open project</Button><Button size="lg" variant="outline" disabled={store.piState !== "ready" || store.isBusy} onClick={() => void store.startOneOffChat()}><ChatIcon /> One-off chat</Button></div>{store.error && <p className="welcome-error" role="alert">{store.error}</p>}</div>
        ) : (
          <div className="workbench"><div className="chat-layout"><Transcript sessionId={store.session.sessionId} store={store} /><ComposerPanel store={store} /></div></div>
        )}
      </section>
      <CommandPane store={store} />
      {store.pendingTrustPath && <div className="dialog-backdrop"><Confirmation state="requested" role="alertdialog" aria-labelledby="trust-title" aria-describedby="trust-description"><ConfirmationRequest><ConfirmationTitle id="trust-title">Trust this workspace?</ConfirmationTitle><ConfirmationDescription id="trust-description">{store.pendingTrustPath} contains project-local executable Pi resources. Trust it only if you know its contents.</ConfirmationDescription><ConfirmationActions><ConfirmationAction variant="outline" onClick={() => void store.resolveProjectTrust(false)}>Cancel</ConfirmationAction><ConfirmationAction onClick={() => void store.resolveProjectTrust(true)}>Trust and open</ConfirmationAction></ConfirmationActions></ConfirmationRequest></Confirmation></div>}
      {store.uiRequest && <div className="dialog-backdrop"><UiDialog key={store.uiRequest.uiRequestId} request={store.uiRequest} store={store} /></div>}
      {store.extensionNotifications.length > 0 && <div className="extension-notifications" aria-live="polite">{store.extensionNotifications.map((notification) => <button key={notification.id} className={`notice notice-${notification.tone}`} onClick={() => store.dismissExtensionNotification(notification.id)}><strong>Extension</strong><span>{notification.message}</span></button>)}</div>}
      {(store.piState === "failed" || store.piState === "stopped") && store.projectPath && <div className="agent-recovery"><span>Pi runtime stopped.</span><Button size="sm" onClick={() => void store.restartPi()}>Restart and reopen</Button></div>}
    </main>
  );
});
