import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle
} from "@/components/ai-elements/confirmation";
import { Composer, ComposerInput, ComposerToolbar } from "@/components/ai-elements/composer";
import { Conversation } from "@/components/ai-elements/conversation";
import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageContent, MessageLabel } from "@/components/ai-elements/message";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Source } from "@/components/ai-elements/source";
import { Tool } from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import type { SessionTreeNode, UiPart } from "../ipc/session-contract";
import { WindowStore, type UiRequestState } from "./stores/window-store";

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

const FolderIcon = () => <Icon><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" /></Icon>;
const PlusIcon = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>;
const ChatIcon = () => <Icon><path d="M20 15a3 3 0 0 1-3 3H8l-5 3 1.7-5.1A7 7 0 0 1 4 13V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" /></Icon>;
const PaperclipIcon = () => <Icon><path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9" /></Icon>;
const SendIcon = () => <Icon><path d="m5 12 7-7 7 7M12 19V5" /></Icon>;
const SettingsIcon = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></Icon>;

function SessionTree({ nodes, store }: { nodes: SessionTreeNode[]; store: WindowStore }) {
  return <ul className="session-tree">{nodes.map((node) => <li key={node.id} className={node.active ? "active" : ""}><div><button onClick={() => void store.navigateTo(node.id)}>{node.label || node.preview || node.type}</button><button title="Fork from here" onClick={() => void store.forkAt(node.id)}>Fork</button></div>{node.children.length > 0 && <SessionTree nodes={node.children} store={store} />}</li>)}</ul>;
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

function UiDialog({ request, store }: { request: UiRequestState; store: WindowStore }) {
  const [value, setValue] = useState(request.kind === "confirm" ? "true" : "");
  const submit = (event: FormEvent) => { event.preventDefault(); void store.respondToUi(value); };
  return (
    <Confirmation state="requested" role="alertdialog" aria-labelledby="ui-title" aria-describedby="ui-message">
      <ConfirmationRequest><form onSubmit={submit}>
        <ConfirmationTitle id="ui-title">{request.title}</ConfirmationTitle>
        <ConfirmationDescription id="ui-message">{request.message}</ConfirmationDescription>
        {request.kind === "select" ? (
          <select className="dialog-field" value={value} onChange={(event) => setValue(event.target.value)} required><option value="">Select…</option>{request.options?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        ) : request.kind !== "confirm" ? (
          <input className="dialog-field" type={request.kind === "secret" ? "password" : "text"} value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} autoFocus />
        ) : null}
        <ConfirmationActions><ConfirmationAction variant="outline" onClick={() => void store.respondToUi(undefined, true)}>Cancel</ConfirmationAction>{request.kind === "confirm" && <ConfirmationAction variant="outline" onClick={() => void store.respondToUi("false")}>Decline</ConfirmationAction>}<ConfirmationAction type="submit">{request.kind === "confirm" ? "Confirm" : "Continue"}</ConfirmationAction></ConfirmationActions>
      </form></ConfirmationRequest>
    </Confirmation>
  );
}

const Sidebar = observer(function Sidebar({ store }: { store: WindowStore }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="cake-mark">C</span><span>Cake</span><span className={`status-dot status-${store.agentState}`} title={`Agent ${store.agentState}`} /></div>
      <button className="new-chat" onClick={() => void store.startOneOffChat()}><ChatIcon /><span>New chat</span><kbd>⌘N</kbd></button>
      <div className="sidebar-scroll">
        <div className="section-heading"><span>Projects</span><div><button aria-label="New window" title="New window" onClick={() => void store.createWindow()}>◫</button><button aria-label="Add project" onClick={() => void store.chooseProject()}><PlusIcon /></button></div></div>
        {store.recentProjectPaths.length === 0 ? <p className="sidebar-empty">Add a folder to start a project.</p> : store.recentProjectPaths.map((path) => {
          const active = path === store.projectPath;
          return <div className="project-group" key={path}>
            <div className={`project-row ${active ? "active" : ""}`}><button className="project-open" title={path} onClick={() => void store.switchProject(path)}><FolderIcon /><span>{store.projects.find((item) => item.path === path)?.name ?? store.nameFromPath(path)}</span></button>{active && <><button className="project-add" title="Rename project" aria-label="Rename project" onClick={() => { const name = window.prompt("Project name", store.projects.find((item) => item.path === path)?.name ?? store.nameFromPath(path)); if (name) void store.renameProject(path, name); }}>✎</button><button className="project-add" title="Remove project" aria-label="Remove project" onClick={() => { if (window.confirm(`Remove ${store.nameFromPath(path)} from Cake? Pi sessions and project files will not be deleted.`)) void store.removeProject(path); }}>−</button><button className="project-add" aria-label={`New chat in ${store.nameFromPath(path)}`} onClick={() => void store.startNewSession()}><PlusIcon /></button></>}</div>
            {active && <div className="session-filter"><input aria-label="Search sessions" placeholder="Search sessions" value={store.sessionSearch} onChange={(event) => store.setSessionSearch(event.target.value)} /><button onClick={() => store.toggleArchived()}>{store.showArchived ? "Active" : "Archive"}</button></div>}
            {active && store.currentSessions.slice(0, 50).map((session) => <div key={session.id} data-session-id={session.id} className={`session-item ${session.id === store.session?.sessionId ? "active" : ""}`}><button className="session-row" onClick={() => void store.openSession(session.id)}><span>{session.title}</span>{session.id === store.session?.sessionId && store.isStreaming && <i />}</button><button className="session-action" aria-label={`${store.showArchived ? "Restore" : "Archive"} ${session.title}`} onClick={() => void store.archiveSession(session.id, !store.showArchived)}>{store.showArchived ? "↩" : "×"}</button></div>)}
          </div>;
        })}
      </div>
      <div className="sidebar-footer">
        <div><strong>{store.agentState === "ready" ? "Agent ready" : `Agent ${store.agentState}`}</strong><span>{store.projectPath ? store.projectName : "Choose a workspace"}</span></div>
        <select aria-label="Color theme" value={store.theme} onChange={(event) => store.setTheme(event.target.value as typeof store.theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
      </div>
    </aside>
  );
});

const ComposerPanel = observer(function ComposerPanel({ store }: { store: WindowStore }) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void store.submit();
    }
  };
  const selectedModel = store.session?.model;
  const unauthenticatedProviders = store.modelsByProvider.filter((provider) => provider.models.some((model) => !model.authenticated));
  return (
    <div className="composer-dock">
      <Composer className="workbench-composer" onSubmit={(event) => { event.preventDefault(); void store.submit(); }}>
        {store.attachments.length > 0 && <div className="attachment-list">{store.attachments.map((attachment, index) => <button type="button" key={`${attachment.kind}-${attachment.name}`} onClick={() => store.removeAttachment(index)}>{attachment.kind === "file" ? "@" : "▧"} {attachment.name} <span>×</span></button>)}</div>}
        <ComposerInput aria-label="Message" placeholder={store.isStreaming ? "Add the next instruction…" : `Ask Cake to work in ${store.projectName}…`} value={store.draft} onChange={(event) => store.setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <ComposerToolbar className="composer-toolbar">
          <div className="composer-context">
            <button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={() => void store.addAttachments()}><PaperclipIcon /></button>
            <select aria-label="Model" value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onChange={(event) => void store.selectModel(event.target.value)}><option value="">Choose model</option>{store.modelsByProvider.map((provider) => <optgroup key={provider.id} label={provider.name}>{provider.models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}{model.authenticated ? "" : " · sign in"}</option>)}</optgroup>)}</select>
            <select aria-label="Thinking level" value={store.session?.thinkingLevel} onChange={(event) => void store.selectThinkingLevel(event.target.value as NonNullable<typeof store.session>["thinkingLevel"])}>{store.session?.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "No reasoning" : `${level.charAt(0).toUpperCase()}${level.slice(1)} reasoning`}</option>)}</select>
            <details className="composer-settings"><summary aria-label="Provider settings"><SettingsIcon /></summary><div className="settings-popover"><strong>Providers</strong>{unauthenticatedProviders.length === 0 ? <span>All available providers are connected.</span> : unauthenticatedProviders.slice(0, 5).map((provider) => { const model = provider.models.find((item) => !item.authenticated)!; return <div key={provider.id}><span>{provider.name}</span>{model.authTypes.map((authType) => <Button key={authType} variant="outline" size="sm" type="button" onClick={() => void store.authenticate(model.provider, authType)}>{authType === "oauth" ? "Connect" : "Add key"}</Button>)}</div>; })}</div></details>
          </div>
          <div className="composer-actions">
            {store.isStreaming && <><Button variant="ghost" size="sm" type="button" onClick={() => void store.abort()}>Stop</Button><Button variant="outline" size="sm" type="button" disabled={!store.canSubmit} onClick={() => void store.submit("steer")}>Steer</Button></>}
            <Button className="send-button" size="sm" type="submit" disabled={!store.canSubmit}>{store.isStreaming ? "Queue" : "Send"}<SendIcon /></Button>
          </div>
        </ComposerToolbar>
      </Composer>
      <p className="composer-hint">Enter to {store.isStreaming ? "queue" : "send"} · Shift+Enter for a new line{store.isStreaming ? " · Steer changes the active turn" : ""}</p>
    </div>
  );
});

export const App = observer(function App() {
  const store = useStore(WindowStore);
  useEffect(() => {
    document.documentElement.dataset.theme = store.theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [store.theme]);

  if (!store.hydrated) return <main className="loading-screen"><span className="cake-mark">C</span><p>Restoring Cake…</p></main>;

  return (
    <main className="app-shell">
      <Sidebar store={store} />
      <section className="workspace" data-session-id={store.session?.sessionId}>
        <header className="workspace-header"><div><strong>{store.session ? (store.session.sessions.find((item) => item.id === store.session?.sessionId)?.title || "New chat") : "Cake"}</strong>{store.projectPath && <span>{store.projectPath}</span>}</div>{store.session && <div className="header-actions"><button className="header-new" onClick={() => { const name = window.prompt("Session name", store.session?.sessions.find((item) => item.id === store.session?.sessionId)?.title); if (name) void store.renameCurrentSession(name); }}>Rename</button><button className="header-new" onClick={() => void store.startNewSession()}><PlusIcon /> New chat</button></div>}</header>
        {!store.session ? (
          <div className="welcome"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build?</h1><p>Open a project for durable workspace chats, or start a one-off chat from your home directory.</p><div><Button size="lg" disabled={store.agentState !== "ready" || store.isBusy} onClick={() => void store.chooseProject()}><FolderIcon /> Open project</Button><Button size="lg" variant="outline" disabled={store.agentState !== "ready" || store.isBusy} onClick={() => void store.startOneOffChat()}><ChatIcon /> One-off chat</Button></div>{store.error && <p className="welcome-error" role="alert">{store.error}</p>}</div>
        ) : (
          <div className="workbench"><nav className="surface-tabs" aria-label="Workspace surfaces">{(["chat", "changes", "terminal", "tree"] as const).map((surface) => <button key={surface} className={store.activeSurface === surface ? "active" : ""} onClick={() => void store.setSurface(surface)}>{surface}</button>)}</nav>
            {store.activeSurface === "chat" ? <div className="chat-layout"><div className="transcript"><Conversation>{store.parts.length === 0 ? <div className="chat-empty"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build in <em>{store.projectName}</em>?</h1><p>Describe a task, ask a question, or attach a file to get started.</p></div> : groupTranscriptParts(store.parts).map((item) => item.kind === "activity-group" ? <ActivityGroup key={item.id} parts={item.parts} store={store} /> : <TranscriptPart key={item.id} part={item} store={store} />)}{store.error && <div className="notice notice-error" role="alert"><strong>Operation failed</strong><span>{store.error}</span></div>}</Conversation></div><ComposerPanel store={store} /></div>
            : store.activeSurface === "changes" ? <section className="secondary-surface"><header><h2>Changed files</h2><Button variant="outline" size="sm" onClick={() => void store.refreshChanges()}>Refresh</Button></header>{store.changedFiles.length === 0 ? <p>No changed files.</p> : store.changedFiles.map((file) => <details key={`${file.staged}-${file.path}`}><summary><code>{file.status}</code> {file.path}<span>+{file.additions} −{file.deletions}</span></summary><pre>{file.diff || "Diff unavailable for this file."}</pre></details>)}</section>
            : store.activeSurface === "terminal" ? <section className="secondary-surface terminal-surface"><header><h2>Terminal</h2><span>{store.terminalRunning ? "running" : "stopped"}</span></header><pre aria-live="polite">{store.terminalOutput}</pre><form onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const input = new FormData(form).get("command"); if (typeof input === "string") { void store.writeTerminal(`${input}\r`); form.reset(); } }}><input name="command" aria-label="Terminal input" autoComplete="off" placeholder="Type a command…" /><Button type="submit" size="sm">Run</Button></form></section>
            : <section className="secondary-surface"><header><h2>Session tree</h2><span>Navigate or fork without rewriting Pi history</span></header><SessionTree nodes={store.session.tree} store={store} /></section>}
          </div>
        )}
      </section>
      {store.pendingTrustPath && <div className="dialog-backdrop"><Confirmation state="requested" role="alertdialog" aria-labelledby="trust-title" aria-describedby="trust-description"><ConfirmationRequest><ConfirmationTitle id="trust-title">Trust this workspace?</ConfirmationTitle><ConfirmationDescription id="trust-description">{store.pendingTrustPath} contains project-local executable Pi resources. Trust it only if you know its contents.</ConfirmationDescription><ConfirmationActions><ConfirmationAction variant="outline" onClick={() => void store.resolveProjectTrust(false)}>Cancel</ConfirmationAction><ConfirmationAction onClick={() => void store.resolveProjectTrust(true)}>Trust and open</ConfirmationAction></ConfirmationActions></ConfirmationRequest></Confirmation></div>}
      {store.uiRequest && <div className="dialog-backdrop"><UiDialog key={store.uiRequest.uiRequestId} request={store.uiRequest} store={store} /></div>}
      {(store.agentState === "failed" || store.agentState === "stopped") && store.projectPath && <div className="agent-recovery"><span>Workspace agent stopped.</span><Button size="sm" onClick={() => void store.restartAgent()}>Restart and reopen</Button></div>}
    </main>
  );
});
