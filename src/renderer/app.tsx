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
import { diffStats } from "@/components/ai-elements/diff-view";
import { Button } from "@/components/ui/button";
import { ArtifactHost, downloadArtifactMarkdown } from "@/components/artifact-host";
import { ChangeExplorer } from "@/components/change-explorer";
import { ModelCombobox } from "@/components/model-combobox";
import { SessionTree } from "@/components/session-tree";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import type { CompatibilityResource, UiPart } from "../ipc/session-contract";
import { WindowStore, type ReviewRunState, type UiRequestState } from "./stores/window-store";

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
const BackIcon = () => <Icon><path d="m15 18-6-6 6-6" /></Icon>;
const ForwardIcon = () => <Icon><path d="m9 18 6-6-6-6" /></Icon>;
const SidebarIcon = () => <Icon><rect x="3.5" y="4" width="17" height="16" rx="3" /><path d="M9 4v16" /></Icon>;
const ChevronIcon = () => <Icon size={13}><path d="m8 10 4 4 4-4" /></Icon>;
const MoreIcon = () => <Icon><circle cx="5" cy="12" r=".7" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r=".7" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r=".7" fill="currentColor" stroke="none" /></Icon>;
const SettingsIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.83 2.83-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21h-4v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06-2.83-2.83.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3v-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.83-2.83.06.06A1.65 1.65 0 0 0 9 4.68h.08a1.65 1.65 0 0 0 1-1.51V3h4v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06 2.83 2.83-.06.06A1.65 1.65 0 0 0 19.32 9v.08a1.65 1.65 0 0 0 1.51 1H21v4h-.09A1.65 1.65 0 0 0 19.4 15z" /></Icon>;
const CopyIcon = () => <Icon size={15}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>;
const ForkIcon = () => <Icon size={15}><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="12" cy="19" r="2" /><path d="M6 7v2a4 4 0 0 0 4 4h2M18 7v2a4 4 0 0 1-4 4h-2v4" /></Icon>;
const CheckIcon = () => <Icon size={15}><path d="m5 12 4 4L19 6" /></Icon>;
const ChangesIcon = () => <Icon size={15}><path d="M4 7h10M4 17h10M17 4v6M14 7l3 3 3-3M17 14v6M14 17l3 3 3-3" /></Icon>;

function CommandPane({ store }: { store: WindowStore }) {
  if (!store.commandPane || !store.session) return null;
  const title = store.commandPane === "tree" ? "Session tree" : store.commandPane === "changelog" ? "Pi changelog" : "Pi resources";
  const resourceGroups = store.commandPane === "resources"
    ? (["extension", "skill", "prompt", "package"] as CompatibilityResource["kind"][]).map((kind) => ({ kind, resources: store.session!.compatibility.resources.filter((item) => item.kind === kind) }))
    : [];
  const diagnostics = store.commandPane === "resources"
    ? [...new Map([...store.session.compatibility.diagnostics, ...store.compatibilityDiagnostics].map((item) => [item.id, item])).values()]
    : [];
  return (
    <aside className="command-pane secondary-surface" aria-labelledby="command-pane-title">
        <header><div><h2 id="command-pane-title">{title}</h2>{store.commandPane === "tree" && <span>Navigate or fork without rewriting Pi history</span>}{store.commandPane === "changelog" && <span>Version history for this agent runtime</span>}</div><div><Button variant="ghost" size="sm" aria-label={`Close ${title}`} onClick={() => store.closeCommandPane()}>Close</Button></div></header>
        {store.commandPane === "tree"
          ? store.session.tree.length > 0 ? <SessionTree nodes={store.session.tree} onNavigate={(id) => void store.navigateTo(id)} onFork={(id) => void store.forkAt(id)} /> : <p>This session has no branches yet.</p>
          : store.commandPane === "changelog"
            ? store.changelogLoading ? <p>Loading changelog…</p> : <Markdown className="pi-changelog">{store.changelogMarkdown || "No changelog entries found."}</Markdown>
            : <div className="resource-catalog">{diagnostics.length > 0 && <section className="resource-diagnostics"><h3>Diagnostics</h3>{diagnostics.map((item) => <div key={item.id} className={`notice notice-${item.severity}`}><strong>{item.method ?? item.source}</strong><span>{item.message}{item.path ? `\n${item.path}` : ""}</span></div>)}</section>}{resourceGroups.map((group) => <section key={group.kind}><h3>{group.kind[0]!.toUpperCase() + group.kind.slice(1)}s <span>{group.resources.length}</span></h3>{group.resources.length === 0 ? <p>None discovered.</p> : group.resources.map((resource) => <article key={resource.id}><div><strong>{resource.name}</strong><small>{resource.scope} · {resource.origin}</small></div>{resource.description && <p>{resource.description}</p>}{resource.commands.length > 0 && <p><b>Commands</b> {resource.commands.map((command) => `/${command}`).join(", ")}</p>}{resource.tools.length > 0 && <p><b>Tools</b> {resource.tools.join(", ")}</p>}<code title={resource.path}>{resource.source}</code></article>)}</section>)}</div>}
    </aside>
  );
}

function AssistantTextMessage({ part, store }: { part: Extract<UiPart, { kind: "text" }>; store: WindowStore }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    await navigator.clipboard.writeText(part.text);
    setCopied(true);
  };

  return (
    <Message className="assistant-message mr-auto w-full">
      <MessageLabel>{part.status === "streaming" ? "Cake · working" : "Cake"}</MessageLabel>
      <MessageContent className="assistant-message-content"><Markdown streaming={part.status === "streaming"}>{part.text}</Markdown></MessageContent>
      {part.status !== "streaming" && <div className="assistant-message-actions" aria-label="Message actions">
        <button type="button" aria-label={copied ? "Copied response" : "Copy response"} title={copied ? "Copied" : "Copy response"} onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
        {part.entryId && <button type="button" aria-label="Fork response into new chat" title="Fork into new chat" onClick={() => void store.forkAt(part.entryId!)}><ForkIcon /></button>}
      </div>}
    </Message>
  );
}

function TranscriptPart({ part, store }: { part: UiPart; store: WindowStore }) {
  if (part.kind === "text") {
    if (part.role === "assistant") return <AssistantTextMessage part={part} store={store} />;
    return (
      <Message className="ml-auto w-[min(88%,42rem)]">
        <MessageLabel>You</MessageLabel>
        <MessageContent className="user-message"><Markdown streaming={part.status === "streaming"}>{part.text}</Markdown></MessageContent>
      </Message>
    );
  }
  if (part.kind === "reasoning") return <Reasoning open={store.thinkingExpanded} onToggle={() => store.toggleThinking()} streaming={part.status === "streaming"}><Markdown streaming={part.status === "streaming"}>{part.text}</Markdown></Reasoning>;
  if (part.kind === "tool") return <Tool part={part} />;
  if (part.kind === "source") return <Source title={part.title} url={part.url} />;
  if (part.kind === "attachment") return <div className="w-fit rounded-full border border-border px-3 py-1 font-mono text-[0.68rem]">{part.attachmentKind} · {part.name}</div>;
  return <div className={`notice notice-${part.tone}`} role={part.tone === "error" ? "alert" : "status"}><strong>{part.title}</strong>{part.detail && <span>{part.detail}</span>}</div>;
}

type TranscriptItem = UiPart | { kind: "activity-group"; id: string; parts: UiPart[] } | { kind: "assistant-loading"; id: string } | { kind: "review-run"; id: string; run: ReviewRunState };

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
  const logRef = useRef<HTMLDivElement>(null);
  const tools = parts.filter((part) => part.kind === "tool").length;
  const editParts = parts.filter((part): part is Extract<UiPart, { kind: "tool" }> => part.kind === "tool" && part.name === "edit" && Boolean(part.diff));
  const editTotals = editParts.reduce((total, part) => { const stats = diffStats(part.diff!); return { additions: total.additions + stats.additions, deletions: total.deletions + stats.deletions }; }, { additions: 0, deletions: 0 });
  const label = editParts.length > 0 ? `${editParts.length} ${editParts.length === 1 ? "edit" : "edits"} · +${editTotals.additions} −${editTotals.deletions}` : tools === 0 ? "Reasoning" : `${tools} tool ${tools === 1 ? "call" : "calls"}`;
  useLayoutEffect(() => {
    if (!store.isStreaming || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  });
  return (
    <details className="activity-group">
      <summary><span className={store.isStreaming ? "activity-pulse" : ""} />Work log <small>{label}</small></summary>
      <div ref={logRef}>{parts.map((part) => <TranscriptPart key={part.id} part={part} store={store} />)}</div>
    </details>
  );
}

function AssistantLoadingIndicator() {
  return (
    <div className="assistant-loading" role="status" aria-label="Cake is working">
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}

function ReviewRunMessage({ run, store }: { run: ReviewRunState; store: WindowStore }) {
  const count = run.commentCount;
  const label = run.status === "running"
    ? `Replying to ${count} ${count === 1 ? "comment" : "comments"}`
    : run.status === "error"
      ? `${count} ${count === 1 ? "comment needs" : "comments need"} another try`
      : `${count} ${count === 1 ? "comment" : "comments"} replied`;
  return <Message className="review-run-message mr-auto w-full">
    <MessageLabel>{run.status === "running" ? "Cake · working" : "Cake"}</MessageLabel>
    <button type="button" className={run.status} onClick={() => void store.openSessionChanges(run.threadIds[0])}>
      {run.status === "running" && <span className="review-run-spinner" aria-hidden="true" />}
      <strong>{label}</strong><span>View in Changes</span>
    </button>
  </Message>;
}

const TranscriptList = forwardRef<HTMLDivElement, ComponentProps<"div">>(function TranscriptList({ className, ...props }, ref) {
  return <div ref={ref} className={`transcript-list ${className ?? ""}`} aria-label="Conversation" {...props} />;
});

export const Transcript = observer(function Transcript({ store, sessionId }: { store: WindowStore; sessionId: string }) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const reviewRuns = store.sessionReviewRuns ?? [];
  const items: TranscriptItem[] = [
    ...groupTranscriptParts(store.visibleParts),
    ...reviewRuns.map((run) => ({ kind: "review-run" as const, id: `review-run-${run.operationId}`, run })),
    ...(store.isStreaming ? [{ kind: "assistant-loading" as const, id: "assistant-loading" }] : [])
  ];
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

  if (store.visibleParts.length === 0 && reviewRuns.length === 0) {
    return (
      <div className="transcript transcript-empty">
        <Conversation><div className="chat-empty"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build in <em>{store.projectName}</em>?</h1><p>Describe a task, ask a question, or type <code>/</code> for commands.</p></div>{store.isStreaming && <AssistantLoadingIndicator />}<ArtifactsPanel store={store} />{store.error && <div className="notice notice-error" role="alert"><strong>Operation failed</strong><span>{store.error}</span></div>}</Conversation>
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
      itemContent={(_index, item) => <div className="transcript-item">{item.kind === "activity-group" ? <ActivityGroup parts={item.parts} store={store} /> : item.kind === "assistant-loading" ? <AssistantLoadingIndicator /> : item.kind === "review-run" ? <ReviewRunMessage run={item.run} store={store} /> : <TranscriptPart part={item} store={store} />}</div>}
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

export const Sidebar = observer(function Sidebar({ store, onOpenSettings, onOpenChat, onToggle, settingsOpen }: { store: WindowStore; onOpenSettings: () => void; onOpenChat: () => void; onToggle: () => void; settingsOpen: boolean }) {
  const [searchExpanded, setSearchExpanded] = useState(Boolean(store.sessionSearch));
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
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
  const toggleProject = (path: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const activityIndicator = (workspacePath: string, sessionId: string) => {
    const activity = store.sessionActivity(workspacePath, sessionId);
    if (!activity) return null;
    const label = activity === "running" ? "Running" : "Ready, unread";
    return <i className={`session-status session-status-${activity}`} role="img" aria-label={label} title={label} />;
  };
  return (
    <aside className="sidebar">
      <div className="sidebar-window-tools"><button aria-label="Toggle sidebar" onClick={onToggle}><SidebarIcon /></button><button aria-label="Back" disabled><BackIcon /></button><button aria-label="Forward" disabled><ForwardIcon /></button></div>
      <div className="sidebar-brand"><div className="brand-menu"><span>Cake</span><ChevronIcon /></div><div className="brand-actions"><button className={searchExpanded ? "active" : ""} aria-label={searchExpanded ? "Close session search" : "Search sessions"} aria-expanded={searchExpanded} onClick={() => searchExpanded ? closeSearch() : setSearchExpanded(true)}>{searchExpanded ? <CloseIcon /> : <SearchIcon />}</button></div></div>
      <div className="sidebar-scroll">
        <button className="new-chat" onClick={() => navigateToChat(() => store.startOneOffChat())}><ChatIcon /><span>New chat</span></button>
        <div className={`session-filter global-session-filter ${searchExpanded ? "expanded" : ""}`} aria-hidden={!searchExpanded}><input ref={searchInput} aria-label="Search sessions" placeholder="Search all sessions" value={store.sessionSearch} disabled={!searchExpanded} onChange={(event) => store.setSessionSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }} /></div>
        {store.sessionSearch.trim() && <div className="global-session-results">
          {store.searchedSessions.length === 0 ? <p className="sidebar-empty">No matching sessions.</p> : store.searchedSessions.slice(0, 50).map((session) => {
            const actionableCommentCount = store.chatReviewCommentCountForSession(session.workspacePath, session.id);
            return <div key={`${session.workspacePath}:${session.id}`} data-session-id={session.id} className={`session-item ${session.id === store.session?.sessionId && session.workspacePath === store.projectPath ? "active" : ""}`}><button className="session-row global-session-row" aria-current={session.id === store.session?.sessionId && session.workspacePath === store.projectPath ? "page" : undefined} onClick={() => navigateToChat(() => store.openSession(session.workspacePath, session.id))} onContextMenu={(event) => renameSession(event, session.workspacePath, session.id, session.title)}><span title={session.title}>{store.sessionDisplayTitle(session.title)}</span><small>{session.workspaceName}</small>{actionableCommentCount > 0 && <b className="session-review-count">{actionableCommentCount} {actionableCommentCount === 1 ? "comment" : "comments"}</b>}{activityIndicator(session.workspacePath, session.id)}</button></div>;
          })}
        </div>}
        <div className="section-heading projects-heading"><span>Projects</span><div><span className="project-options" aria-hidden="true"><MoreIcon /></span><button aria-label="Add project" onClick={() => navigateToChat(() => store.chooseProject())}><PlusIcon /></button></div></div>
        {store.recentProjectPaths.length === 0 ? <p className="sidebar-empty">Add a folder to start a project.</p> : store.recentProjectPaths.map((path) => {
          const collapsed = collapsedProjects.has(path);
          const sessions = store.projectSessions(path);
          const visibleSessions = sessions.slice(0, store.sessionLimit(path));
          return <div className="project-group" key={path}>
            <div className="project-row" title={path}><button className="project-label" type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${store.projects.find((item) => item.path === path)?.name ?? store.nameFromPath(path)}`} onClick={() => toggleProject(path)}><span className={`project-disclosure ${collapsed ? "collapsed" : ""}`}><ChevronIcon /></span><FolderIcon /><span>{store.projects.find((item) => item.path === path)?.name ?? store.nameFromPath(path)}</span></button><button className="project-add" aria-label={`New chat in ${store.nameFromPath(path)}`} onClick={() => navigateToChat(() => store.startNewSession(path))}><PlusIcon /></button></div>
            {!collapsed && !store.sessionSearch.trim() && visibleSessions.map((session) => {
              const actionableCommentCount = store.chatReviewCommentCountForSession(path, session.id);
              return <div key={session.id} data-session-id={session.id} className={`session-item ${session.id === store.session?.sessionId && path === store.projectPath ? "active" : ""}`}><button className="session-row" aria-current={session.id === store.session?.sessionId && path === store.projectPath ? "page" : undefined} onClick={() => navigateToChat(() => store.openSession(path, session.id))} onContextMenu={(event) => renameSession(event, path, session.id, session.title)}><span title={session.title}>{store.sessionDisplayTitle(session.title)}</span>{actionableCommentCount > 0 && <b className="session-review-count">{actionableCommentCount} {actionableCommentCount === 1 ? "comment" : "comments"}</b>}{activityIndicator(path, session.id)}</button></div>;
            })}
            {!collapsed && !store.sessionSearch.trim() && sessions.length > visibleSessions.length && <button className="session-more" onClick={() => store.showMoreSessions(path)}>Show more</button>}
          </div>;
        })}
      </div>
      <div className="sidebar-footer">
        <button className={settingsOpen ? "sidebar-settings-icon active" : "sidebar-settings-icon"} type="button" aria-label="Open settings" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings}><SettingsIcon /></button>
      </div>
    </aside>
  );
});

const ComposerPanel = observer(function ComposerPanel({ store }: { store: WindowStore }) {
  const selectedModel = store.session?.model;
  const usage = store.session?.usage;
  const context = usage?.context;
  const contextPercent = context?.percent === null || context?.percent === undefined ? undefined : Math.round(context.percent);
  const contextLabel = contextPercent === undefined ? "Context usage unavailable" : `${contextPercent}% context used`;
  const contextTitle = context
    ? `${context.tokens === null ? "Unknown" : context.tokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens`
    : "Context usage is unavailable";
  return (
    <div className="composer-dock">
      {store.extensionWidgets.filter((widget) => widget.placement === "aboveEditor").map((widget) => <div className="legacy-widget" key={widget.key}><strong>{widget.key}</strong><pre>{widget.lines.join("\n")}</pre></div>)}
      <Composer className="workbench-composer" onSubmit={(event) => { event.preventDefault(); void store.submit(); }}>
        {store.chatReviewCommentCount > 0 && <div className="review-context-badge"><button type="button" onClick={() => void store.openSessionChanges()}><span>{store.chatReviewCommentCount}</span> {store.chatReviewCommentCount === 1 ? "comment ready to send" : "comments ready to send"}</button></div>}
        {store.attachments.length > 0 && <div className="attachment-list">{store.attachments.map((attachment, index) => <button type="button" key={`${attachment.kind}-${attachment.name}`} onClick={() => store.removeAttachment(index)}>{attachment.kind === "file" ? "@" : "▧"} {attachment.name} <span>×</span></button>)}</div>}
        <SlashCommandCombobox aria-label="Message" commands={store.session?.commands ?? []} suggestFiles={(prefix) => store.suggestFiles(prefix)} placeholder={store.isStreaming ? "Add the next instruction…" : `Ask Cake to work in ${store.projectName}…`} value={store.draft} onValueChange={(value) => store.setDraft(value)} onSubmit={(value) => { if (value !== undefined) store.setDraft(value); void store.submit(); }} />
        <ComposerToolbar className="composer-toolbar">
          <div className="composer-context">
            <button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={() => void store.addAttachments()}><PaperclipIcon /></button>
            <ModelCombobox ariaLabel="Model" groups={store.connectedModelsByProvider} value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onSelect={(value) => void store.selectModel(value)} />
            <select aria-label="Thinking level" value={store.session?.thinkingLevel} onChange={(event) => void store.selectThinkingLevel(event.target.value as NonNullable<typeof store.session>["thinkingLevel"])}>{store.session?.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "No reasoning" : `${level.charAt(0).toUpperCase()}${level.slice(1)} reasoning`}</option>)}</select>
          </div>
          <div className="composer-actions">
            {usage && <div className="session-usage" aria-label={`${contextLabel}, session cost $${usage.cost.toFixed(3)}`} title={`${contextTitle} · ${usage.tokens.total.toLocaleString()} billed tokens`}><svg className="context-gauge" viewBox="0 0 36 36" aria-hidden="true"><circle className="context-gauge-track" cx="18" cy="18" r="15.5" pathLength="100" /><circle className="context-gauge-value" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${Math.min(100, contextPercent ?? 0)} 100`} /><text x="18" y="18">{contextPercent === undefined ? "—" : `${contextPercent}%`}</text></svg><span className="session-cost">${usage.cost.toFixed(3)}</span></div>}
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

function SettingsToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(checked: boolean): void }) {
  return <div className="settings-field"><span>{label}<small>{description}</small></span><button className="settings-switch" type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button></div>;
}

export const SettingsPage = observer(function SettingsPage({ store }: { store: WindowStore }) {
  const selectedModel = store.session?.model;
  const pi = store.session?.piSettings;
  const authNotice = store.parts.find((part) => part.kind === "notice" && part.id === "auth-status");
  return (
    <div className="settings-page">
      <div className="settings-intro">
        <span className="settings-kicker">Cake / Pi</span>
        <h1>Settings</h1>
        <p>Configure the same Pi runtime used by the CLI. These preferences are saved by Pi and follow you across projects.</p>
      </div>
      {store.error && <div className="notice notice-error" role="alert"><strong>Operation failed</strong><span>{store.error}</span></div>}
      {authNotice?.kind === "notice" && <div className={`notice notice-${authNotice.tone}`} role="status"><strong>{authNotice.title}</strong><span>{authNotice.detail}</span></div>}

      <section className="settings-section" aria-labelledby="pi-settings-title">
        <header><div><h2 id="pi-settings-title">Current chat</h2><p>Model and reasoning changes apply to this chat and become Pi’s defaults.</p></div><span className={`settings-runtime status-${store.piState}`}><i />{store.piState}</span></header>
        {store.session ? <div className="settings-fields">
          <div className="settings-field"><span>Model<small>The model Pi uses for its next response.</small></span><ModelCombobox ariaLabel="Settings model" groups={store.connectedModelsByProvider} value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onSelect={(value) => void store.selectModel(value)} variant="settings" /></div>
          <label><span>Reasoning<small>Controls how much time Pi spends thinking.</small></span><select aria-label="Settings thinking level" value={store.session.thinkingLevel} onChange={(event) => void store.selectThinkingLevel(event.target.value as NonNullable<typeof store.session>["thinkingLevel"])}>{store.session.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "Off" : level.charAt(0).toUpperCase() + level.slice(1)}</option>)}</select></label>
        </div> : <p className="settings-empty">Open a project or start a one-off chat to choose a model and reasoning level.</p>}
      </section>

      <section className="settings-section" aria-labelledby="behavior-title">
        <header><div><h2 id="behavior-title">Agent behavior</h2><p>Context, reasoning display, and queued message delivery.</p></div><span className="settings-source">Pi global</span></header>
        {pi ? <div className="settings-fields">
          <SettingsToggle label="Auto-compact" description="Compact context automatically when it gets too large." checked={pi.autoCompact} onChange={(value) => void store.setPiSetting({ key: "autoCompact", value })} />
          <SettingsToggle label="Hide thinking" description="Hide reasoning blocks in assistant responses." checked={pi.hideThinkingBlock} onChange={(value) => void store.setPiSetting({ key: "hideThinkingBlock", value })} />
          <label><span>Steering mode<small>How steering messages are delivered while Pi is working.</small></span><select aria-label="Steering mode" value={pi.steeringMode} onChange={(event) => void store.setPiSetting({ key: "steeringMode", value: event.target.value as typeof pi.steeringMode })}><option value="one-at-a-time">One at a time</option><option value="all">All at once</option></select></label>
          <label><span>Follow-up mode<small>How queued follow-ups are delivered after Pi stops.</small></span><select aria-label="Follow-up mode" value={pi.followUpMode} onChange={(event) => void store.setPiSetting({ key: "followUpMode", value: event.target.value as typeof pi.followUpMode })}><option value="one-at-a-time">One at a time</option><option value="all">All at once</option></select></label>
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="content-title">
        <header><div><h2 id="content-title">Content & resources</h2><p>Control images, skills, diagrams, and transcript diagnostics.</p></div></header>
        {pi ? <div className="settings-fields">
          <SettingsToggle label="Auto-resize images" description="Resize large images for better model compatibility." checked={pi.autoResizeImages} onChange={(value) => void store.setPiSetting({ key: "autoResizeImages", value })} />
          <SettingsToggle label="Block images" description="Prevent images from being sent to model providers." checked={pi.blockImages} onChange={(value) => void store.setPiSetting({ key: "blockImages", value })} />
          <SettingsToggle label="Skill commands" description="Register discovered skills as /skill:name commands." checked={pi.enableSkillCommands} onChange={(value) => void store.setPiSetting({ key: "enableSkillCommands", value })} />
          <label><span>Mermaid diagrams<small>Choose when Pi renders Mermaid code blocks as diagrams.</small></span><select aria-label="Mermaid rendering" value={pi.mermaidRenderingMode} onChange={(event) => void store.setPiSetting({ key: "mermaidRenderingMode", value: event.target.value as typeof pi.mermaidRenderingMode })}><option value="off">Off</option><option value="final">Final responses</option><option value="streaming">While streaming</option></select></label>
          <SettingsToggle label="Cache miss notices" description="Show notices for significant prompt-cache misses." checked={pi.showCacheMissNotices} onChange={(value) => void store.setPiSetting({ key: "showCacheMissNotices", value })} />
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="network-title">
        <header><div><h2 id="network-title">Network</h2><p>Choose Pi’s provider transport and idle timeout.</p></div></header>
        {pi ? <div className="settings-fields">
          <label><span>Transport<small>Preferred transport when a provider supports more than one.</small></span><select aria-label="Provider transport" value={pi.transport} onChange={(event) => void store.setPiSetting({ key: "transport", value: event.target.value as typeof pi.transport })}><option value="auto">Automatic</option><option value="sse">SSE</option><option value="websocket">WebSocket</option><option value="websocket-cached">WebSocket cached</option></select></label>
          <label><span>HTTP idle timeout<small>Maximum pause while Pi waits for HTTP data.</small></span><select aria-label="HTTP idle timeout" value={pi.httpIdleTimeoutMs} onChange={(event) => void store.setPiSetting({ key: "httpIdleTimeoutMs", value: Number(event.target.value) })}><option value={30_000}>30 seconds</option><option value={60_000}>1 minute</option><option value={120_000}>2 minutes</option><option value={300_000}>5 minutes</option><option value={0}>Disabled</option></select></label>
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="safety-title">
        <header><div><h2 id="safety-title">Safety & privacy</h2><p>Trust defaults, warnings, and Pi’s optional update telemetry.</p></div></header>
        {pi ? <div className="settings-fields">
          <label><span>Default project trust<small>Fallback when no saved trust decision applies.</small></span><select aria-label="Default project trust" value={pi.defaultProjectTrust} onChange={(event) => void store.setPiSetting({ key: "defaultProjectTrust", value: event.target.value as typeof pi.defaultProjectTrust })}><option value="ask">Ask</option><option value="always">Always trust</option><option value="never">Never trust</option></select></label>
          <SettingsToggle label="Anthropic extra usage warning" description="Warn when subscription authentication may use paid extra usage." checked={pi.anthropicExtraUsageWarning} onChange={(value) => void store.setPiSetting({ key: "anthropicExtraUsageWarning", value })} />
          <SettingsToggle label="Install telemetry" description="Send Pi’s anonymous version/update ping after detected updates." checked={pi.enableInstallTelemetry} onChange={(value) => void store.setPiSetting({ key: "enableInstallTelemetry", value })} />
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="cli-title">
        <header><div><h2 id="cli-title">Pi CLI</h2><p>Preferences shared with Pi’s terminal interface.</p></div></header>
        {pi ? <div className="settings-fields">
          <label><span>Double-escape action<small>Action Pi takes when Escape is pressed twice in an empty editor.</small></span><select aria-label="Double escape action" value={pi.doubleEscapeAction} onChange={(event) => void store.setPiSetting({ key: "doubleEscapeAction", value: event.target.value as typeof pi.doubleEscapeAction })}><option value="tree">Open tree</option><option value="fork">Fork</option><option value="none">None</option></select></label>
          <label><span>Tree filter mode<small>Default filter used when Pi opens /tree.</small></span><select aria-label="Tree filter mode" value={pi.treeFilterMode} onChange={(event) => void store.setPiSetting({ key: "treeFilterMode", value: event.target.value as typeof pi.treeFilterMode })}><option value="default">Default</option><option value="no-tools">Hide tools</option><option value="user-only">User messages only</option><option value="labeled-only">Labeled only</option><option value="all">All entries</option></select></label>
          <SettingsToggle label="Quiet startup" description="Disable Pi CLI’s verbose startup output." checked={pi.quietStartup} onChange={(value) => void store.setPiSetting({ key: "quietStartup", value })} />
          <SettingsToggle label="Collapse changelog" description="Show a condensed changelog after Pi updates." checked={pi.collapseChangelog} onChange={(value) => void store.setPiSetting({ key: "collapseChangelog", value })} />
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="providers-title">
        <header><div><h2 id="providers-title">Providers</h2><p>Connect the accounts and API keys that make models available to Pi.</p></div></header>
        {store.modelsByProvider.length === 0 ? <p className="settings-empty">Provider details will appear after a chat is open.</p> : <div className="provider-list">{store.modelsByProvider.map((provider) => {
          const authenticated = provider.models.some((model) => model.authenticated);
          const authenticatedModel = provider.models.find((model) => model.authenticated);
          const authSource = authenticatedModel?.authSource;
          const externallyManaged = Boolean(authenticated && authSource && authSource !== "stored" && authSource !== "runtime");
          const connectionLabel = authenticatedModel?.authLabel ?? (authSource === "environment" ? "environment" : undefined);
          const authTypes = [...new Set(provider.models.flatMap((model) => model.authTypes))];
          const operation = store.providerOperation(provider.id);
          return <article className="provider-row" key={provider.id}><div className="provider-identity"><span className="provider-monogram">{provider.name.slice(0, 1).toUpperCase()}</span><span><strong>{provider.name}</strong><small>{provider.models.length} {provider.models.length === 1 ? "model" : "models"}</small></span></div><span className={authenticated ? "provider-state connected" : "provider-state"}><i />{operation === "login" ? "Connecting…" : operation === "logout" ? "Disconnecting…" : authenticated ? `Connected${connectionLabel ? ` · ${connectionLabel}` : ""}` : "Not connected"}</span><div className="provider-actions">{authenticated ? externallyManaged ? <small className="provider-managed" title="Remove this credential from its environment or configuration source, then restart Cake.">Remove externally, then restart</small> : <Button variant="outline" size="sm" type="button" disabled={Boolean(operation)} onClick={() => void store.logout(provider.id)}>{operation === "logout" ? "Disconnecting…" : "Disconnect"}</Button> : authTypes.map((authType) => <Button key={authType} variant={authType === "oauth" ? "default" : "outline"} size="sm" type="button" disabled={Boolean(operation)} onClick={() => void store.authenticate(provider.id, authType)}>{operation === "login" ? "Connecting…" : authType === "oauth" ? "Connect" : "Add API key"}</Button>)}</div></article>;
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = store.theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [store.theme]);
  useEffect(() => {
    document.title = store.extensionTitle ? `${store.extensionTitle} · Cake` : "Cake";
  }, [store.extensionTitle]);
  useEffect(() => {
    if (!store.commandPane && store.changeExplorerPath === undefined) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (store.changeExplorerPath !== undefined) store.closeChangeExplorer();
      else store.closeCommandPane();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [store, store.commandPane, store.changeExplorerPath]);

  if (!store.hydrated) return <main className="loading-screen"><span className="cake-mark">C</span><p>Restoring Cake…</p></main>;
  if (store.changeExplorerPath !== undefined) return <ChangeExplorer store={store} />;

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${store.commandPane ? "right-pane-open" : ""}`}>
      <Sidebar store={store} settingsOpen={page === "settings"} onToggle={() => setSidebarCollapsed((value) => !value)} onOpenSettings={() => setPage("settings")} onOpenChat={() => setPage("chat")} />
      <section className="workspace" data-session-id={store.session?.sessionId}>
        <button className={page === "settings" ? "workspace-settings-icon active" : "workspace-settings-icon"} type="button" aria-label="Open settings" aria-current={page === "settings" ? "page" : undefined} onClick={() => setPage("settings")}><SettingsIcon /></button>
        <header className="workspace-header"><div><button className="header-sidebar-toggle" aria-label="Toggle sidebar" onClick={() => setSidebarCollapsed((value) => !value)}><SidebarIcon /></button>{page === "settings" && <button className="header-back" aria-label="Back to chat" onClick={() => setPage("chat")}><BackIcon /></button>}<strong>{page === "settings" ? "Settings" : store.extensionTitle ?? (store.session ? store.sessionTitle : "Cake")}</strong>{page === "chat" && store.projectPath && <span>{store.projectPath}</span>}</div>{page === "chat" && store.session && <button className="header-pane-toggle" type="button" aria-label="Open session changes" onClick={() => void store.openSessionChanges()}><ChangesIcon /><span>Changes</span>{store.sessionChanges.length > 0 && <b>{store.sessionChanges.length}</b>}</button>}</header>
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
