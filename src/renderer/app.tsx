import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type FormEvent, type ReactNode } from "react";
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
import { WorkspaceBrowser } from "@/components/workspace-browser";
import { ModelCombobox } from "@/components/model-combobox";
import { SessionTree } from "@/components/session-tree";
import { SlashCommandCombobox } from "@/components/slash-command-combobox";
import { PanelResizeHandle } from "@/components/panel-resize-handle";
import { CopyErrorDetailsButton } from "@/components/copy-error-details-button";
import { AssistantMessageFullscreen } from "@/components/assistant-message-fullscreen";
import { MessageCommentDraftPopover, MessageCommentThreadPopover, MessageSelectionAction, type MessageCommentAnchorRect } from "@/components/message-comment-popover";
import type { CompatibilityResource, PiSettings, UiPart } from "../ipc/session-contract";
import type { MainChatStore } from "./stores/MainChatStore";
import type { ReviewsStore } from "./stores/ReviewsStore";
import type { SidebarStore } from "./stores/SidebarStore";
import type { SettingsStore } from "./stores/SettingsStore";
import { RootStore } from "./stores/RootStore";
import type { ExtensionUiStore, UiRequestState } from "./stores/ExtensionUiStore";
import type { ArtifactInteractionStore } from "./stores/ArtifactInteractionStore";
import type { MessageComposerStore } from "./stores/MessageComposerStore";
import type { GlobalChatStore } from "./stores/GlobalChatStore";
import type { ChatConfigurationStore } from "./stores/ChatConfigurationStore";
import type { TranscriptViewStore } from "./stores/TranscriptViewStore";
import type { InlineWidgetStore } from "./stores/InlineWidgetStore";
import type { MessageCommentsStore, MessageSelectionAnchor } from "./stores/MessageCommentsStore";
import type { ArtifactRecord } from "../ipc/artifact-contract";

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
const ExpandIcon = () => <Icon size={15}><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" /></Icon>;
const CheckIcon = () => <Icon size={15}><path d="m5 12 4 4L19 6" /></Icon>;
const ChangesIcon = () => <Icon size={15}><path d="M4 7h10M4 17h10M17 4v6M14 7l3 3 3-3M17 14v6M14 17l3 3 3-3" /></Icon>;
const BrowseIcon = () => <Icon size={15}><path d="M4 5.5h6l1.8 2H20v11H4z" /><path d="M4 9h16" /></Icon>;

function CommandPane({ store, extensionUi }: { store: MainChatStore; extensionUi: ExtensionUiStore }) {
  if (!store.commandPane || !store.session) return null;
  const title = store.commandPane === "tree" ? "Session tree" : store.commandPane === "changelog" ? "Pi changelog" : "Pi resources";
  const resourceGroups = store.commandPane === "resources"
    ? (["extension", "skill", "prompt", "package"] as CompatibilityResource["kind"][]).map((kind) => ({ kind, resources: store.session!.compatibility.resources.filter((item) => item.kind === kind) }))
    : [];
  const diagnostics = store.commandPane === "resources"
    ? [...new Map([...store.session.compatibility.diagnostics, ...extensionUi.compatibilityDiagnostics].map((item) => [item.id, item])).values()]
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

const messageHighlightRanges = new Map<string, Range[]>();

function refreshMessageHighlights() {
  const registry = Reflect.get(globalThis.CSS ?? {}, "highlights") as { set(name: string, value: unknown): void; delete(name: string): void } | undefined;
  const HighlightConstructor = Reflect.get(globalThis, "Highlight") as (new (...ranges: Range[]) => unknown) | undefined;
  if (!registry || !HighlightConstructor) return;
  if (!document.getElementById("cake-message-comment-highlight-style")) {
    const style = document.createElement("style");
    style.id = "cake-message-comment-highlight-style";
    style.textContent = "::highlight(cake-message-comment){background:color-mix(in oklab,var(--accent) 28%,transparent);text-decoration:underline;text-decoration-color:color-mix(in oklab,var(--accent) 75%,transparent);text-decoration-thickness:2px;text-underline-offset:2px}";
    document.head.appendChild(style);
  }
  const ranges = [...messageHighlightRanges.values()].flat();
  if (ranges.length === 0) registry.delete("cake-message-comment");
  else registry.set("cake-message-comment", new HighlightConstructor(...ranges));
}

function textOffset(container: Node, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
}

function rangeAtOffsets(container: Node, start: number, end: number) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let traversed = 0;
  let startPoint: { node: Node; offset: number } | undefined;
  let endPoint: { node: Node; offset: number } | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!startPoint && start <= traversed + length) startPoint = { node, offset: Math.max(0, start - traversed) };
    if (end <= traversed + length) { endPoint = { node, offset: Math.max(0, end - traversed) }; break; }
    traversed += length;
  }
  if (!startPoint || !endPoint) return undefined;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

export function captureMessageSelection(container: HTMLElement, messageId: string, entryId?: string): MessageSelectionAnchor | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return undefined;
  const raw = range.toString();
  const selectedText = raw.trim();
  if (!selectedText) return undefined;
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const startOffset = textOffset(container, range.startContainer, range.startOffset) + leading;
  const endOffset = textOffset(container, range.endContainer, range.endOffset) - trailing;
  const text = container.textContent ?? "";
  return {
    messageId,
    entryId,
    selectedText,
    startOffset,
    endOffset,
    contextBefore: text.slice(Math.max(0, startOffset - 320), startOffset),
    contextAfter: text.slice(endOffset, endOffset + 320)
  };
}

export const MESSAGE_COMMENT_SELECTION_DELAY_MS = 450;

function plainRect(rect: DOMRect): MessageCommentAnchorRect {
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}

const AssistantTextMessage = observer(function AssistantTextMessage({ part, behavior }: { part: Extract<UiPart, { kind: "text" }>; behavior: TranscriptBehavior }) {
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [selectionAction, setSelectionAction] = useState<{ selection: MessageSelectionAnchor; rect: MessageCommentAnchorRect }>();
  const [draft, setDraft] = useState<{ selection: MessageSelectionAnchor; anchor: MessageCommentAnchorRect }>();
  const [openThread, setOpenThread] = useState<{ id: string; anchor: HTMLElement | MessageCommentAnchorRect }>();
  const [markerPositions, setMarkerPositions] = useState<Record<string, { left: number; top: number }>>({});
  const selectionTimer = useRef<number | undefined>(undefined);
  const messageRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const commentThreads = behavior.messageComments?.threadsForMessage(part.id) ?? [];
  const closeFullscreen = useCallback(() => setFullscreen(false), []);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  useEffect(() => () => window.clearTimeout(selectionTimer.current), []);

  const copy = async () => {
    await navigator.clipboard.writeText(part.text);
    setCopied(true);
  };

  const content = () => <Markdown>{part.text}</Markdown>;

  useLayoutEffect(() => {
    const key = `${part.id}:${part.entryId ?? ""}`;
    const container = contentRef.current;
    const ranges = container ? commentThreads.flatMap((thread) => {
      const start = thread.anchor.startOffset;
      const end = thread.anchor.endOffset;
      if (start === undefined || end === undefined) return [];
      const range = rangeAtOffsets(container, start, end);
      return range ? [range] : [];
    }) : [];
    messageHighlightRanges.set(key, ranges);
    refreshMessageHighlights();
    return () => { messageHighlightRanges.delete(key); refreshMessageHighlights(); };
  }, [part.id, part.entryId, part.text, commentThreads.map((thread) => `${thread.id}:${thread.updatedAt}`).join("|")]);

  useLayoutEffect(() => {
    const message = messageRef.current;
    const content = contentRef.current;
    if (!message || !content) return;
    const update = () => {
      const messageRect = message.getBoundingClientRect();
      const next: Record<string, { left: number; top: number }> = {};
      for (const thread of commentThreads) {
        const start = thread.anchor.startOffset;
        const end = thread.anchor.endOffset;
        if (start === undefined || end === undefined) continue;
        const range = rangeAtOffsets(content, start, end);
        const rangeRects = range ? Array.from(range.getClientRects()) : [];
        const rect = rangeRects.at(-1) ?? range?.getBoundingClientRect();
        if (!rect) continue;
        next[thread.id] = {
          left: Math.min(Math.max(8, rect.right - messageRect.left + 7), Math.max(8, messageRect.width - 30)),
          top: rect.top - messageRect.top + rect.height / 2
        };
      }
      setMarkerPositions(next);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(content);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [part.text, commentThreads.map((thread) => `${thread.id}:${thread.anchor.startOffset}:${thread.anchor.endOffset}`).join("|")]);

  const scheduleSelectionAction = () => {
    window.clearTimeout(selectionTimer.current);
    setSelectionAction(undefined);
    if (!behavior.messageComments || part.status === "streaming" || !contentRef.current) return;
    const captured = captureMessageSelection(contentRef.current, part.id, part.entryId);
    const selection = window.getSelection();
    if (!captured || !selection?.rangeCount) return;
    const rect = plainRect(selection.getRangeAt(0).getBoundingClientRect());
    selectionTimer.current = window.setTimeout(() => {
      if (window.getSelection()?.toString().trim() === captured.selectedText) setSelectionAction({ selection: captured, rect });
    }, MESSAGE_COMMENT_SELECTION_DELAY_MS);
  };

  const activeThread = openThread ? commentThreads.find((thread) => thread.id === openThread.id) : undefined;

  return (
    <Message ref={messageRef} className="assistant-message mr-auto w-full">
      <MessageLabel>{part.status === "streaming" ? "Cake · working" : "Cake"}</MessageLabel>
      <button className="assistant-message-expand" type="button" aria-label="View response fullscreen" title="View fullscreen" onClick={() => setFullscreen(true)}><ExpandIcon /></button>
      <MessageContent ref={contentRef} className="assistant-message-content" onMouseUp={scheduleSelectionAction}>{content()}</MessageContent>
      {commentThreads.map((thread, index) => markerPositions[thread.id] && <button key={thread.id} className={`message-comment-marker ${thread.status}`} style={markerPositions[thread.id]} type="button" aria-label={`Open selection chat ${index + 1}`} title={thread.anchor.selectedText} onClick={(event) => setOpenThread({ id: thread.id, anchor: event.currentTarget })}><ChatIcon /><b>{thread.messages.length}</b></button>)}
      {selectionAction && <MessageSelectionAction rect={selectionAction.rect} onChat={(anchor) => { setDraft({ selection: selectionAction.selection, anchor }); setSelectionAction(undefined); }} />}
      {draft && behavior.messageComments && <MessageCommentDraftPopover anchor={draft.anchor} selection={draft.selection} store={behavior.messageComments} onClose={() => setDraft(undefined)} onCreated={(threadId) => {
        setOpenThread({ id: threadId, anchor: draft.anchor });
        setDraft(undefined);
        window.getSelection()?.removeAllRanges();
      }} />}
      {activeThread && behavior.messageComments && <MessageCommentThreadPopover anchor={openThread!.anchor} thread={activeThread} store={behavior.messageComments} onClose={() => setOpenThread(undefined)} />}
      {part.status !== "streaming" && <div className="assistant-message-actions" aria-label="Message actions">
        <button type="button" aria-label={copied ? "Copied response" : "Copy response"} title={copied ? "Copied" : "Copy response"} onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}</button>
        {part.entryId && behavior.onFork && <button type="button" aria-label="Fork response into new chat" title="Fork into new chat" onClick={() => behavior.onFork!(part.entryId!)}><ForkIcon /></button>}
      </div>}
      {fullscreen && <AssistantMessageFullscreen onClose={closeFullscreen}>{content()}</AssistantMessageFullscreen>}
    </Message>
  );
});

interface TranscriptBehavior {
  thinkingExpanded: boolean;
  onToggleThinking(): void;
  onFork?(entryId: string): void;
  onOpenReviewRun?(threadId?: string): void;
  inlineWidgets?: { store: InlineWidgetStore; workspacePath: string; sessionId: string; model?: { provider: string; id: string } };
  artifacts?: { records: ArtifactRecord[]; interaction: ArtifactInteractionStore };
  messageComments?: MessageCommentsStore;
}

const TranscriptPart = observer(function TranscriptPart({ part, behavior }: { part: UiPart; behavior: TranscriptBehavior }) {
  if (part.kind === "text") {
    if (part.role === "assistant") return <AssistantTextMessage part={part} behavior={behavior} />;
    return (
      <Message className="ml-auto w-[min(88%,42rem)]">
        <MessageLabel>You</MessageLabel>
        <MessageContent className="user-message"><Markdown>{part.text}</Markdown></MessageContent>
      </Message>
    );
  }
  if (part.kind === "reasoning") return <Reasoning open={behavior.thinkingExpanded} onToggle={behavior.onToggleThinking} streaming={part.status === "streaming"} hasContent={Boolean(part.text.trim())}><Markdown>{part.text}</Markdown></Reasoning>;
  if (part.kind === "tool") {
    const record = part.artifactId ? behavior.artifacts?.records.find((candidate) => candidate.artifact.id === part.artifactId) : undefined;
    if (record && behavior.artifacts) {
      const request = behavior.artifacts.interaction.request?.record.artifact.id === record.artifact.id ? behavior.artifacts.interaction.request : undefined;
      return <ArtifactHost record={record} requested={Boolean(request)} onSubmit={(value) => void behavior.artifacts!.interaction.respond(value)} onCancel={() => void behavior.artifacts!.interaction.respond(undefined, true)} inlineWidgets={behavior.inlineWidgets?.store} />;
    }
    return <Tool part={part} />;
  }
  if (part.kind === "source") return <Source title={part.title} url={part.url} />;
  if (part.kind === "attachment") return part.attachmentKind === "image" && part.data
    ? <figure className="transcript-image"><img src={`data:${part.mediaType};base64,${part.data}`} alt={part.name} /><figcaption>{part.name}</figcaption></figure>
    : <div className="w-fit rounded-full border border-border px-3 py-1 font-mono text-[0.68rem]">{part.attachmentKind} · {part.name}</div>;
  if (part.kind === "review-run") return <ReviewRunMessage run={part} onOpen={behavior.onOpenReviewRun} />;
  return <div className={`notice notice-${part.tone}`} role={part.tone === "error" ? "alert" : "status"}><strong>{part.title}</strong>{part.detail && <span>{part.detail}</span>}</div>;
});

type TranscriptItem = UiPart | { kind: "activity-group"; id: string; parts: UiPart[] } | { kind: "assistant-loading"; id: string };

function errorNoticeFollowsUser(items: TranscriptItem[], index: number) {
  const item = items[index];
  const previous = items[index - 1];
  return item?.kind === "notice"
    && item.tone === "error"
    && previous?.kind === "text"
    && previous.role === "user";
}

function groupTranscriptParts(parts: UiPart[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let activity: UiPart[] = [];
  const flush = () => {
    if (activity.length === 0) return;
    items.push({ kind: "activity-group", id: `activity-${activity[0]!.id}`, parts: activity });
    activity = [];
  };
  for (const part of parts) {
    if ((part.kind === "tool" && !part.artifactId) || part.kind === "reasoning") activity.push(part);
    else {
      flush();
      items.push(part);
    }
  }
  flush();
  return items;
}

function ActivityGroup({ parts, behavior, isStreaming }: { parts: UiPart[]; behavior: TranscriptBehavior; isStreaming: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);
  const tools = parts.filter((part) => part.kind === "tool").length;
  const reasoningParts = parts.filter((part): part is Extract<UiPart, { kind: "reasoning" }> => part.kind === "reasoning");
  const reasoningHasContent = reasoningParts.some((part) => Boolean(part.text.trim()));
  const reasoningIsStreaming = reasoningParts.some((part) => part.status === "streaming");
  const toolParts = parts.filter((part): part is Extract<UiPart, { kind: "tool" }> => part.kind === "tool");
  const activityIsRunning = reasoningIsStreaming || toolParts.some((part) => part.state === "running");
  const editParts = parts.filter((part): part is Extract<UiPart, { kind: "tool" }> => part.kind === "tool" && part.name === "edit" && Boolean(part.diff));
  const editTotals = editParts.reduce((total, part) => { const stats = diffStats(part.diff!); return { additions: total.additions + stats.additions, deletions: total.deletions + stats.deletions }; }, { additions: 0, deletions: 0 });
  const label = editParts.length > 0 ? `${editParts.length} ${editParts.length === 1 ? "edit" : "edits"} · +${editTotals.additions} −${editTotals.deletions}` : tools === 0 ? "Reasoning" : `${tools} tool ${tools === 1 ? "call" : "calls"}`;
  useLayoutEffect(() => {
    if (!isStreaming || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  });
  if (tools === 0 && !reasoningHasContent) {
    return <div className="activity-group activity-group-status" role="status"><span className={`work-log-state${activityIsRunning ? " work-log-running" : ""}`} aria-label={activityIsRunning ? "working" : "complete"} />{reasoningIsStreaming ? "Thinking…" : "Reasoning details not exposed"}</div>;
  }
  return (
    <details className="activity-group">
      <summary><span className={`work-log-state${activityIsRunning ? " work-log-running" : ""}`} aria-label={activityIsRunning ? "working" : "complete"} />Work log <small>{label}</small></summary>
      <div ref={logRef}>{parts.map((part) => <TranscriptPart key={part.id} part={part} behavior={behavior} />)}</div>
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

function ReviewRunMessage({ run, onOpen }: { run: Extract<UiPart, { kind: "review-run" }>; onOpen?(threadId?: string): void }) {
  const count = run.commentCount;
  const label = run.status === "running"
    ? `Replying to ${count} ${count === 1 ? "comment" : "comments"}`
    : run.status === "error"
      ? `${count} ${count === 1 ? "comment needs" : "comments need"} another try`
      : `${count} ${count === 1 ? "comment" : "comments"} replied`;
  return <Message className="review-run-message mr-auto w-full">
    <MessageLabel>{run.status === "running" ? "Cake · working" : "Cake"}</MessageLabel>
    <button type="button" className={run.status} disabled={!onOpen} onClick={() => onOpen?.(run.threadIds[0])}>
      {run.status === "running" && <span className="review-run-spinner" aria-hidden="true" />}
      <strong>{label}</strong><span>View in Changes</span>
    </button>
  </Message>;
}

const TranscriptList = forwardRef<HTMLDivElement, ComponentProps<"div">>(function TranscriptList({ className, ...props }, ref) {
  return <div ref={ref} className={`transcript-list ${className ?? ""}`} aria-label="Conversation" {...props} />;
});

function ErrorNotice({ title, message, details = message }: { title: string; message: string; details?: string }) {
  return <div className="notice notice-error" role="alert"><strong>{title}</strong><span>{message}</span><CopyErrorDetailsButton details={details} /></div>;
}

export const Transcript = observer(function Transcript({ parts, sessionId, isStreaming, hideThinking = false, behavior, empty, footer, error, errorDetails, errorTitle = "Operation failed" }: { parts: UiPart[]; sessionId: string; isStreaming: boolean; hideThinking?: boolean; behavior: TranscriptBehavior; empty: ReactNode; footer?: ReactNode; error?: string; errorDetails?: string; errorTitle?: string }) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const visibleParts = hideThinking ? parts.filter((part) => part.kind !== "reasoning") : parts;
  const latestUserIndex = visibleParts.findLastIndex((part) => (part.kind === "text" && part.role === "user") || (part.kind === "attachment" && part.attachmentKind === "image"));
  const currentTurnParts = visibleParts.slice(latestUserIndex + 1);
  const workLogIsActive = currentTurnParts.some((part) => part.kind === "reasoning"
    ? part.status === "streaming"
    : part.kind === "tool" && part.state === "running");
  const assistantMessageIsStreaming = currentTurnParts.some((part) => part.kind === "text" && part.role === "assistant" && part.status === "streaming");
  const showAssistantLoading = isStreaming && assistantMessageIsStreaming && !workLogIsActive;
  const items: TranscriptItem[] = [
    ...groupTranscriptParts(visibleParts),
    ...(showAssistantLoading ? [{ kind: "assistant-loading" as const, id: "assistant-loading" }] : [])
  ];
  const latestUserPartId = parts.findLast((part) => (part.kind === "text" && part.role === "user") || (part.kind === "attachment" && part.attachmentKind === "image"))?.id;
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

  if (visibleParts.length === 0) {
    return (
      <div className="transcript transcript-empty">
        <Conversation>{empty}{showAssistantLoading && <AssistantLoadingIndicator />}{footer}{error && <ErrorNotice title={errorTitle} message={error} details={errorDetails} />}</Conversation>
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
        Footer: () => <div className="transcript-footer">{footer}{error && <ErrorNotice title={errorTitle} message={error} details={errorDetails} />}</div>
      }}
      itemContent={(index, item) => <div className={`transcript-item${errorNoticeFollowsUser(items, index) ? " transcript-item-error-after-user" : ""}`}>{item.kind === "activity-group" ? <ActivityGroup parts={item.parts} behavior={behavior} isStreaming={isStreaming} /> : item.kind === "assistant-loading" ? <AssistantLoadingIndicator /> : item.kind === "review-run" ? <ReviewRunMessage run={item} onOpen={behavior.onOpenReviewRun} /> : <TranscriptPart part={item} behavior={behavior} />}</div>}
    />
  );
});

const ArtifactsPanel = observer(function ArtifactsPanel({ store, artifacts, inlineWidgets }: { store: MainChatStore; artifacts: ArtifactInteractionStore; inlineWidgets: InlineWidgetStore }) {
  if (store.artifacts.length === 0) return null;
  const linked = new Set(store.canonicalParts.flatMap((part) => part.kind === "tool" && part.artifactId ? [part.artifactId] : []));
  const unlinked = store.artifacts.filter((record) => !linked.has(record.artifact.id));
  return <section className="artifacts-panel" aria-label="Session artifacts">{unlinked.map((record) => { const request = artifacts.request?.record.artifact.id === record.artifact.id ? artifacts.request : undefined; return <ArtifactHost key={record.artifact.id} record={record} requested={Boolean(request)} onSubmit={(value) => void artifacts.respond(value)} onCancel={() => void artifacts.respond(undefined, true)} inlineWidgets={inlineWidgets} />; })}<details className="artifacts-index"><summary>{store.artifacts.length} session {store.artifacts.length === 1 ? "artifact" : "artifacts"}</summary><div><Button variant="ghost" size="sm" onClick={() => { void artifacts.exportMarkdown().then(downloadArtifactMarkdown); }}>Export Markdown</Button>{store.artifacts.map((record) => <span key={record.artifact.id}>{record.artifact.title ?? record.artifact.id} <small>{record.artifact.kind} · r{record.artifact.revision}</small></span>)}</div></details></section>;
});

function UiDialog({ request, extensionUi }: { request: UiRequestState; extensionUi: ExtensionUiStore }) {
  const [value, setValue] = useState(request.kind === "confirm" ? "true" : request.initialValue ?? "");
  const submit = (event: FormEvent) => { event.preventDefault(); void extensionUi.respond(value); };
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
        <ConfirmationActions><ConfirmationAction variant="outline" onClick={() => void extensionUi.respond(undefined, true)}>Cancel</ConfirmationAction>{request.kind === "confirm" && <ConfirmationAction variant="outline" onClick={() => void extensionUi.respond("false")}>Decline</ConfirmationAction>}<ConfirmationAction type="submit">{request.kind === "confirm" ? "Confirm" : "Continue"}</ConfirmationAction></ConfirmationActions>
      </form></ConfirmationRequest>
    </Confirmation>
  );
}

export const Sidebar = observer(function Sidebar({ store, chat, reviews, onOpenSettings, onOpenChat, onOpenGlobalChat, onToggle, onReloadPi, settingsOpen, globalChatOpen }: { store: SidebarStore; chat: MainChatStore; reviews: ReviewsStore; onOpenSettings: () => void; onOpenChat: () => void; onOpenGlobalChat: () => void; onToggle: () => void; onReloadPi?: () => void; settingsOpen: boolean; globalChatOpen: boolean }) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const searchInput = useRef<HTMLInputElement>(null);
  const searchOpen = searchExpanded || Boolean(store.search);
  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);
  const closeSearch = () => {
    store.search = "";
    chat.persistViewState();
    setSearchExpanded(false);
  };
  const navigateToChat = (action: () => void | Promise<unknown>) => {
    onOpenChat();
    void action();
  };
  const renameSession = (event: React.MouseEvent, workspacePath: string, sessionId: string, title: string) => {
    event.preventDefault();
    const name = window.prompt("Session name", title);
    if (name) void chat.renameSession(workspacePath, sessionId, name);
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
      <div className="sidebar-brand"><details className="brand-menu"><summary><span>Cake</span><ChevronIcon /></summary><div className="brand-dropdown"><button type="button" disabled={!chat.session || !onReloadPi} onClick={(event) => { onReloadPi?.(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Reload Pi<span>{chat.session?.piSettings?.reloadPending ? "Queued" : "Settings and resources"}</span></button></div></details><div className="brand-actions"><button className={searchOpen ? "active" : ""} aria-label={searchOpen ? "Close session search" : "Search sessions"} aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : setSearchExpanded(true)}>{searchOpen ? <CloseIcon /> : <SearchIcon />}</button></div></div>
      <div className="sidebar-scroll">
        <button className={`new-chat global-chat-link${globalChatOpen ? " active" : ""}`} aria-current={globalChatOpen ? "page" : undefined} onClick={onOpenGlobalChat}><span className="cake-mini-mark">C</span><span>Global chat</span></button>
        <button className="new-chat" onClick={() => navigateToChat(() => chat.startOneOffChat())}><ChatIcon /><span>New chat</span></button>
        <div className={`session-filter global-session-filter ${searchOpen ? "expanded" : ""}`} aria-hidden={!searchOpen}><input ref={searchInput} aria-label="Search sessions" placeholder="Search all sessions" value={store.search} disabled={!searchOpen} onChange={(event) => { store.search = event.target.value; chat.persistViewState(); }} onKeyDown={(event) => { if (event.key === "Escape") closeSearch(); }} /></div>
        {store.search.trim() && <div className="global-session-results">
          {store.searchedSessions.length === 0 ? <p className="sidebar-empty">No matching sessions.</p> : store.searchedSessions.slice(0, 50).map((session) => {
            const actionableCommentCount = reviews.chatCommentCountForSession(session.workspacePath, session.id);
            return <div key={`${session.workspacePath}:${session.id}`} data-session-id={session.id} className={`session-item ${session.id === chat.session?.sessionId && session.workspacePath === chat.projectPath ? "active" : ""}`}><button className="session-row global-session-row" aria-current={session.id === chat.session?.sessionId && session.workspacePath === chat.projectPath ? "page" : undefined} onClick={() => navigateToChat(() => chat.openSession(session.workspacePath, session.id))} onContextMenu={(event) => renameSession(event, session.workspacePath, session.id, session.title)}><span title={session.title}>{store.sessionDisplayTitle(session.title)}</span><small>{session.workspaceName}</small>{actionableCommentCount > 0 && <b className="session-review-count">{actionableCommentCount} {actionableCommentCount === 1 ? "comment" : "comments"}</b>}{activityIndicator(session.workspacePath, session.id)}</button></div>;
          })}
        </div>}
        <div className="section-heading projects-heading"><span>Projects</span><div><span className="project-options" aria-hidden="true"><MoreIcon /></span><button aria-label="Add project" onClick={() => navigateToChat(() => chat.chooseProject())}><PlusIcon /></button></div></div>
        {store.recentProjectPaths.length === 0 ? <p className="sidebar-empty">Add a folder to start a project.</p> : store.recentProjectPaths.map((path) => {
          const collapsed = collapsedProjects.has(path);
          const sessions = store.projectSessions(path);
          const visibleSessions = sessions.slice(0, store.sessionLimit(path));
          return <div className="project-group" key={path}>
            <div className="project-row" title={path}><button className="project-label" type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${store.projects.find((item) => item.path === path)?.name ?? store.nameFromPath(path)}`} onClick={() => toggleProject(path)}><span className={`project-disclosure ${collapsed ? "collapsed" : ""}`}><ChevronIcon /></span><FolderIcon /><span>{store.projects.find((item) => item.path === path)?.name ?? store.nameFromPath(path)}</span></button><button className="project-add" aria-label={`New chat in ${store.nameFromPath(path)}`} onClick={() => navigateToChat(() => chat.startNewSession(path))}><PlusIcon /></button></div>
            {!collapsed && !store.search.trim() && visibleSessions.map((session) => {
              const actionableCommentCount = reviews.chatCommentCountForSession(path, session.id);
              return <div key={session.id} data-session-id={session.id} className={`session-item ${session.id === chat.session?.sessionId && path === chat.projectPath ? "active" : ""}`}><button className="session-row" aria-current={session.id === chat.session?.sessionId && path === chat.projectPath ? "page" : undefined} onClick={() => navigateToChat(() => chat.openSession(path, session.id))} onContextMenu={(event) => renameSession(event, path, session.id, session.title)}><span title={session.title}>{store.sessionDisplayTitle(session.title)}</span>{actionableCommentCount > 0 && <b className="session-review-count">{actionableCommentCount} {actionableCommentCount === 1 ? "comment" : "comments"}</b>}{activityIndicator(path, session.id)}</button></div>;
            })}
            {!collapsed && !store.search.trim() && sessions.length > visibleSessions.length && <button className="session-more" onClick={() => store.showMoreSessions(path)}>Show more</button>}
          </div>;
        })}
      </div>
      <div className="sidebar-footer">
        <button className={settingsOpen ? "sidebar-settings-icon active" : "sidebar-settings-icon"} type="button" aria-label="Open settings" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings}><SettingsIcon /></button>
      </div>
    </aside>
  );
});

const ChatComposer = observer(function ChatComposer({ configuration, onSubmit, input, children, toolbarLeading, toolbarActions }: { configuration: ChatConfigurationStore; onSubmit(event: FormEvent): void; input: ReactNode; children?: ReactNode; toolbarLeading?: ReactNode; toolbarActions: ReactNode }) {
  const session = configuration.session;
  const selectedModel = session?.model;
  return <Composer className="workbench-composer" onSubmit={onSubmit}>
    {children}
    {input}
    <ComposerToolbar className="composer-toolbar">
      <div className="composer-context">
        {toolbarLeading}
        <ModelCombobox ariaLabel="Model" groups={configuration.connectedModelsByProvider} value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onSelect={(value) => void configuration.selectModel(value)} />
        <select aria-label="Thinking level" value={session?.thinkingLevel ?? "off"} onChange={(event) => void configuration.selectThinkingLevel(event.target.value as NonNullable<typeof session>["thinkingLevel"])}>{session?.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "No reasoning" : `${level.charAt(0).toUpperCase()}${level.slice(1)} reasoning`}</option>)}</select>
      </div>
      <div className="composer-actions">{toolbarActions}</div>
    </ComposerToolbar>
  </Composer>;
});

const GlobalChatPanel = observer(function GlobalChatPanel({ store, configuration, transcriptView }: { store: GlobalChatStore; configuration: ChatConfigurationStore; transcriptView: TranscriptViewStore }) {
  const submit = (event: FormEvent) => { event.preventDefault(); void store.submit(); };
  return <div className="workbench global-chat"><div className="chat-layout">
    <Transcript parts={store.parts} sessionId={store.sessionId ?? "global-chat"} isStreaming={store.streaming} hideThinking={store.session?.piSettings?.hideThinkingBlock} behavior={{ thinkingExpanded: transcriptView.thinkingExpanded, onToggleThinking: () => transcriptView.toggleThinking() }} empty={<div className="chat-empty"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What can I help you find or do?</h1><p>Ask about your tasks, open one, or delegate work to it.</p></div>} error={store.error} errorDetails={store.errorDetails} errorTitle="Global chat failed" />
    <div className="composer-dock"><ChatComposer configuration={configuration} onSubmit={submit} input={<SlashCommandCombobox autoFocus aria-label="Message global chat" commands={store.session?.commands ?? []} placeholder="Ask Cake to find or control a task…" value={store.draft} onValueChange={(value) => store.setDraft(value)} onSubmit={(value) => { if (value !== undefined) store.setDraft(value); void store.submit(); }} />} toolbarActions={<>{store.streaming && <Button variant="ghost" size="sm" type="button" onClick={() => void store.abort()}>Stop</Button>}<Button className="send-button" size="sm" type="submit" disabled={!store.draft.trim()}>{store.streaming ? "Queue" : "Send"}<SendIcon /></Button></>} /></div>
  </div></div>;
});

const ComposerPanel = observer(function ComposerPanel({ store, composer, reviews, configuration, extensionUi }: { store: MainChatStore; composer: MessageComposerStore; reviews: ReviewsStore; configuration: ChatConfigurationStore; extensionUi: ExtensionUiStore }) {
  const usage = store.session?.usage;
  const context = usage?.context;
  const contextPercent = context?.percent === null || context?.percent === undefined ? undefined : Math.round(context.percent);
  const contextLabel = contextPercent === undefined ? "Context usage unavailable" : `${contextPercent}% context used`;
  const contextTitle = context
    ? `${context.tokens === null ? "Unknown" : context.tokens.toLocaleString()} of ${context.contextWindow.toLocaleString()} context tokens`
    : "Context usage is unavailable";
  return (
    <div className="composer-dock">
      {extensionUi.widgets.filter((widget) => widget.placement === "aboveEditor").map((widget) => <div className="legacy-widget" key={widget.key}><strong>{widget.key}</strong><pre>{widget.lines.join("\n")}</pre></div>)}
      <ChatComposer configuration={configuration} onSubmit={(event) => { event.preventDefault(); void composer.submit(); }} input={<SlashCommandCombobox autoFocus aria-label="Message" commands={[...(store.session?.commands ?? []), ...store.pluginCommands]} focusRequestRevision={composer.focusRequestRevision} suggestFiles={(prefix) => composer.suggestFiles(prefix)} placeholder={store.isStreaming ? "Add the next instruction…" : `Ask Cake to work in ${store.projectName}…`} value={store.draft} onValueChange={(value) => store.setDraft(value)} onPaste={(event) => {
          const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
          if (images.length === 0) {
            for (const item of event.clipboardData.items) {
              if (!item.type.startsWith("image/")) continue;
              const file = item.getAsFile();
              if (file) images.push(file);
            }
          }
          if (images.length === 0) return;
          event.preventDefault();
          void composer.addPastedImages(images);
        }} onSubmit={(value) => { if (value !== undefined) store.setDraft(value); void composer.submit(); }} />} toolbarLeading={<button type="button" className="icon-button" aria-label="Attach files" title="Attach files" onClick={() => void composer.addAttachments()}><PaperclipIcon /></button>} toolbarActions={<>{usage && <div className="session-usage" aria-label={`${contextLabel}, session cost $${usage.cost.toFixed(3)}`} title={`${contextTitle} · ${usage.tokens.total.toLocaleString()} billed tokens`}><svg className="context-gauge" viewBox="0 0 36 36" aria-hidden="true"><circle className="context-gauge-track" cx="18" cy="18" r="15.5" pathLength="100" /><circle className="context-gauge-value" cx="18" cy="18" r="15.5" pathLength="100" strokeDasharray={`${Math.min(100, contextPercent ?? 0)} 100`} /><text x="18" y="18">{contextPercent === undefined ? "—" : `${contextPercent}%`}</text></svg><span className="session-cost">${usage.cost.toFixed(3)}</span></div>}{store.isStreaming && <><Button variant="ghost" size="sm" type="button" onClick={() => void store.abort()}>Stop</Button><Button variant="outline" size="sm" type="button" disabled={!store.canSubmit} onClick={() => void composer.submit("steer")}>Steer</Button></>}<Button className="send-button" size="sm" type="submit" disabled={!store.canSubmit}>{store.isStreaming ? "Queue" : "Send"}<SendIcon /></Button></>}>
        {reviews.chatCommentCount > 0 && <div className="review-context-badge"><button type="button" onClick={() => void store.openSessionChanges()}><span>{reviews.chatCommentCount}</span> {reviews.chatCommentCount === 1 ? "comment ready to send" : "comments ready to send"}</button></div>}
        {composer.attachments.length > 0 && <div className="attachment-list">{composer.attachments.map((attachment, index) => attachment.kind === "image"
          ? <button className="image-attachment" type="button" aria-label={`Remove ${attachment.name}`} key={`${attachment.kind}-${attachment.name}-${index}`} onClick={() => composer.removeAttachment(index)}><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /><span>{attachment.name}<b aria-hidden="true">×</b></span></button>
          : <button type="button" key={`${attachment.kind}-${attachment.name}-${index}`} onClick={() => composer.removeAttachment(index)}>@ {attachment.name} <span>×</span></button>)}</div>}
      </ChatComposer>
      {extensionUi.widgets.filter((widget) => widget.placement === "belowEditor").map((widget) => <div className="legacy-widget" key={widget.key}><strong>{widget.key}</strong><pre>{widget.lines.join("\n")}</pre></div>)}
      {extensionUi.statuses.length > 0 && <div className="extension-statuses" role="status">{extensionUi.statuses.map((status) => <span key={status.key}><strong>{status.key}</strong> {status.text}</span>)}</div>}
    </div>
  );
});

function SettingsToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(checked: boolean): void }) {
  return <div className="settings-field"><span>{label}<small>{description}</small></span><button className="settings-switch" type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button></div>;
}

function SettingsTextField({ label, description, value, placeholder, onApply }: { label: string; description: string; value: string; placeholder?: string; onApply(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label><span>{label}<small>{description}</small></span><input className="settings-input" value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onApply(draft); }} /></label>;
}

function SettingsLinesField({ label, description, value, onApply }: { label: string; description: string; value: string[]; onApply(value: string[]): void }) {
  const serialized = value.join("\n");
  const [draft, setDraft] = useState(serialized);
  useEffect(() => setDraft(serialized), [serialized]);
  return <label className="settings-multiline"><span>{label}<small>{description}</small></span><textarea value={draft} rows={4} onChange={(event) => setDraft(event.target.value)} onBlur={() => { const next = draft.split("\n").map((item) => item.trim()).filter(Boolean); if (next.join("\n") !== serialized) onApply(next); }} /></label>;
}

function SettingsPackagesField({ value, onApply }: { value: PiSettings["packages"]; onApply(value: PiSettings["packages"]): void }) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => { setDraft(serialized); setError(undefined); }, [serialized]);
  const apply = () => {
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!Array.isArray(parsed)) throw new Error("Packages must be a JSON array");
      onApply(parsed as PiSettings["packages"]);
      setError(undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };
  return <label className="settings-multiline"><span>Packages<small>Pi package sources as JSON. Saving reloads every open Pi session.</small>{error && <small className="settings-validation" role="alert">{error}</small>}</span><span className="settings-editor"><textarea aria-label="Pi packages" value={draft} rows={6} onChange={(event) => setDraft(event.target.value)} /><Button variant="outline" size="sm" type="button" onClick={apply}>Apply</Button></span></label>;
}

export const SettingsPage = observer(function SettingsPage({ store, settings, configuration }: { store: MainChatStore; settings: SettingsStore; configuration: ChatConfigurationStore }) {
  const selectedModel = store.session?.model;
  const pi = store.session?.piSettings;
  const authNotice = store.canonicalParts.find((part) => part.kind === "notice" && part.id === "auth-status");
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
          <div className="settings-field"><span>Model<small>The model Pi uses for its next response.</small></span><ModelCombobox ariaLabel="Settings model" groups={configuration.connectedModelsByProvider} value={selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : ""} onSelect={(value) => void configuration.selectModel(value)} variant="settings" /></div>
          <label><span>Reasoning<small>Controls how much time Pi spends thinking.</small></span><select aria-label="Settings thinking level" value={store.session.thinkingLevel} onChange={(event) => void configuration.selectThinkingLevel(event.target.value as NonNullable<typeof store.session>["thinkingLevel"])}>{store.session.availableThinkingLevels.map((level) => <option key={level} value={level}>{level === "off" ? "Off" : level.charAt(0).toUpperCase() + level.slice(1)}</option>)}</select></label>
        </div> : <p className="settings-empty">Open a project or start a one-off chat to choose a model and reasoning level.</p>}
      </section>

      <section className="settings-section" aria-labelledby="behavior-title">
        <header><div><h2 id="behavior-title">Agent behavior</h2><p>Context, reasoning display, and queued message delivery.</p></div><span className="settings-source">Pi global</span></header>
        {pi ? <div className="settings-fields">
          <SettingsToggle label="Auto-compact" description="Compact context automatically when it gets too large." checked={pi.autoCompact} onChange={(value) => void settings.setPiSetting({ key: "autoCompact", value })} />
          <SettingsToggle label="Automatic retry" description="Retry transient provider failures automatically." checked={pi.retryEnabled} onChange={(value) => void settings.setPiSetting({ key: "retryEnabled", value })} />
          <SettingsToggle label="Hide thinking" description="Hide reasoning blocks in assistant responses." checked={pi.hideThinkingBlock} onChange={(value) => void settings.setPiSetting({ key: "hideThinkingBlock", value })} />
          <label><span>Steering mode<small>How steering messages are delivered while Pi is working.</small></span><select aria-label="Steering mode" value={pi.steeringMode} onChange={(event) => void settings.setPiSetting({ key: "steeringMode", value: event.target.value as typeof pi.steeringMode })}><option value="one-at-a-time">One at a time</option><option value="all">All at once</option></select></label>
          <label><span>Follow-up mode<small>How queued follow-ups are delivered after Pi stops.</small></span><select aria-label="Follow-up mode" value={pi.followUpMode} onChange={(event) => void settings.setPiSetting({ key: "followUpMode", value: event.target.value as typeof pi.followUpMode })}><option value="one-at-a-time">One at a time</option><option value="all">All at once</option></select></label>
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="execution-title">
        <header><div><h2 id="execution-title">Execution</h2><p>Configure the shell and package command used by Pi.</p></div></header>
        {pi ? <div className="settings-fields">
          <SettingsTextField label="Shell path" description="Custom shell executable. Leave empty to use Pi’s platform default." value={pi.shellPath} placeholder="/bin/zsh" onApply={(value) => void settings.setPiSetting({ key: "shellPath", value })} />
          <SettingsTextField label="Shell command prefix" description="Command prepended to every Pi shell invocation." value={pi.shellCommandPrefix} placeholder="Optional" onApply={(value) => void settings.setPiSetting({ key: "shellCommandPrefix", value })} />
          <SettingsLinesField label="npm command" description="Command and arguments used for package operations, one argument per line." value={pi.npmCommand} onApply={(value) => void settings.setPiSetting({ key: "npmCommand", value })} />
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="resources-title">
        <header><div><h2 id="resources-title">Resources</h2><p>Configure global Pi packages, extensions, skills, and prompt paths. Changes reload automatically.</p></div><Button variant="outline" size="sm" type="button" disabled={!store.session} onClick={() => void settings.reloadPi()}>{pi?.reloadPending ? "Reload queued" : "Reload Pi"}</Button></header>
        {pi ? <div className="settings-fields">
          <SettingsPackagesField value={pi.packages} onApply={(value) => void settings.setPiSetting({ key: "packages", value })} />
          <SettingsLinesField label="Extension paths" description="One path, glob, inclusion, or exclusion per line." value={pi.extensions} onApply={(value) => void settings.setPiSetting({ key: "extensions", value })} />
          <SettingsLinesField label="Skill paths" description="One path, glob, inclusion, or exclusion per line." value={pi.skills} onApply={(value) => void settings.setPiSetting({ key: "skills", value })} />
          <SettingsLinesField label="Prompt paths" description="One path, glob, inclusion, or exclusion per line." value={pi.prompts} onApply={(value) => void settings.setPiSetting({ key: "prompts", value })} />
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="content-title">
        <header><div><h2 id="content-title">Content</h2><p>Control images, skills, and transcript diagnostics.</p></div></header>
        {pi ? <div className="settings-fields">
          <SettingsToggle label="Auto-resize images" description="Resize large images for better model compatibility." checked={pi.autoResizeImages} onChange={(value) => void settings.setPiSetting({ key: "autoResizeImages", value })} />
          <SettingsToggle label="Block images" description="Prevent images from being sent to model providers." checked={pi.blockImages} onChange={(value) => void settings.setPiSetting({ key: "blockImages", value })} />
          <SettingsToggle label="Skill commands" description="Register discovered skills as /skill:name commands." checked={pi.enableSkillCommands} onChange={(value) => void settings.setPiSetting({ key: "enableSkillCommands", value })} />
          <SettingsToggle label="Cache miss notices" description="Show notices for significant prompt-cache misses." checked={pi.showCacheMissNotices} onChange={(value) => void settings.setPiSetting({ key: "showCacheMissNotices", value })} />
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="network-title">
        <header><div><h2 id="network-title">Network</h2><p>Choose Pi’s provider transport and idle timeout.</p></div></header>
        {pi ? <div className="settings-fields">
          <label><span>Transport<small>Preferred transport when a provider supports more than one.</small></span><select aria-label="Provider transport" value={pi.transport} onChange={(event) => void settings.setPiSetting({ key: "transport", value: event.target.value as typeof pi.transport })}><option value="auto">Automatic</option><option value="sse">SSE</option><option value="websocket">WebSocket</option><option value="websocket-cached">WebSocket cached</option></select></label>
          <label><span>HTTP idle timeout<small>Maximum pause while Pi waits for HTTP data.</small></span><select aria-label="HTTP idle timeout" value={pi.httpIdleTimeoutMs} onChange={(event) => void settings.setPiSetting({ key: "httpIdleTimeoutMs", value: Number(event.target.value) })}><option value={30_000}>30 seconds</option><option value={60_000}>1 minute</option><option value={120_000}>2 minutes</option><option value={300_000}>5 minutes</option><option value={0}>Disabled</option></select></label>
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="safety-title">
        <header><div><h2 id="safety-title">Safety & privacy</h2><p>Trust defaults, warnings, and Pi’s optional update telemetry.</p></div></header>
        {pi ? <div className="settings-fields">
          <label><span>Default project trust<small>Fallback when no saved trust decision applies.</small></span><select aria-label="Default project trust" value={pi.defaultProjectTrust} onChange={(event) => void settings.setPiSetting({ key: "defaultProjectTrust", value: event.target.value as typeof pi.defaultProjectTrust })}><option value="ask">Ask</option><option value="always">Always trust</option><option value="never">Never trust</option></select></label>
          <SettingsToggle label="Anthropic extra usage warning" description="Warn when subscription authentication may use paid extra usage." checked={pi.anthropicExtraUsageWarning} onChange={(value) => void settings.setPiSetting({ key: "anthropicExtraUsageWarning", value })} />
          <SettingsToggle label="Install telemetry" description="Send Pi’s anonymous version/update ping after detected updates." checked={pi.enableInstallTelemetry} onChange={(value) => void settings.setPiSetting({ key: "enableInstallTelemetry", value })} />
        </div> : <p className="settings-empty">Open a chat to load Pi’s settings.</p>}
      </section>

      <section className="settings-section" aria-labelledby="providers-title">
        <header><div><h2 id="providers-title">Providers</h2><p>Connect the accounts and API keys that make models available to Pi.</p></div></header>
        {configuration.modelsByProvider.length === 0 ? <p className="settings-empty">Provider details will appear after a chat is open.</p> : <div className="provider-list">{configuration.modelsByProvider.map((provider) => {
          const authenticated = provider.models.some((model) => model.authenticated);
          const authenticatedModel = provider.models.find((model) => model.authenticated);
          const authSource = authenticatedModel?.authSource;
          const externallyManaged = Boolean(authenticated && authSource && authSource !== "stored" && authSource !== "runtime");
          const connectionLabel = authenticatedModel?.authLabel ?? (authSource === "environment" ? "environment" : undefined);
          const authTypes = [...new Set(provider.models.flatMap((model) => model.authTypes))];
          const operation = settings.providerOperation(provider.id);
          return <article className="provider-row" key={provider.id}><div className="provider-identity"><span className="provider-monogram">{provider.name.slice(0, 1).toUpperCase()}</span><span><strong>{provider.name}</strong><small>{provider.models.length} {provider.models.length === 1 ? "model" : "models"}</small></span></div><span className={authenticated ? "provider-state connected" : "provider-state"}><i />{operation === "login" ? "Connecting…" : operation === "logout" ? "Disconnecting…" : authenticated ? `Connected${connectionLabel ? ` · ${connectionLabel}` : ""}` : "Not connected"}</span><div className="provider-actions">{authenticated ? externallyManaged ? <small className="provider-managed" title="Remove this credential from its environment or configuration source, then restart Cake.">Remove externally, then restart</small> : <Button variant="outline" size="sm" type="button" disabled={Boolean(operation)} onClick={() => void settings.logout(provider.id)}>{operation === "logout" ? "Disconnecting…" : "Disconnect"}</Button> : authTypes.map((authType) => <Button key={authType} variant={authType === "oauth" ? "default" : "outline"} size="sm" type="button" disabled={Boolean(operation)} onClick={() => void settings.authenticate(provider.id, authType)}>{operation === "login" ? "Connecting…" : authType === "oauth" ? "Connect" : "Add API key"}</Button>)}</div></article>;
        })}</div>}
      </section>

      <section className="settings-section" aria-labelledby="appearance-title">
        <header><div><h2 id="appearance-title">Appearance</h2><p>Choose how Cake looks on this device.</p></div></header>
        <div className="settings-fields"><label><span>Theme<small>Follow your system or use a fixed appearance.</small></span><select aria-label="Color theme" value={settings.theme} onChange={(event) => { settings.setTheme(event.target.value as typeof settings.theme); store.persistViewState(); }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
      </section>
    </div>
  );
});

export const App = observer(function App() {
  const root = useStore(RootStore);
  const store = root.mainChatStore;
  const sidebar = root.sidebarStore;
  const browse = root.browseStore;
  const changes = root.changesStore;
  const reviews = root.reviewsStore;
  const settings = root.settingsStore;
  const chatConfiguration = root.mainChatConfigurationStore;
  const extensionUi = root.extensionUiStore;
  const artifactInteractions = root.artifactInteractionStore;
  const navigation = root.navigationStore;
  const page = navigation.page;
  const globalChat = page === "global" ? root.globalChatStore : undefined;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(292);
  const [commandPaneWidth, setCommandPaneWidth] = useState(420);
  const [resizingPanel, setResizingPanel] = useState(false);
  const sidebarMax = Math.max(240, window.innerWidth - (store.commandPane ? commandPaneWidth : 0) - 360);
  const commandPaneMax = Math.max(320, window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth) - 360);
  const returnToChat = useCallback(() => {
    browse.close();
    changes.close();
    navigation.openChat();
    root.messageComposerStore.requestFocus();
  }, [browse, changes, navigation, root]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [settings.theme]);
  useEffect(() => {
    document.title = extensionUi.title ? `${extensionUi.title} · Cake` : "Cake";
  }, [extensionUi.title]);
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (browse.path !== undefined || changes.path !== undefined) returnToChat();
      else if (store.commandPane) store.closeCommandPane();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [store, browse, changes, returnToChat]);

  if (!store.hydrated) return <main className="loading-screen"><span className="cake-mark">C</span><p>Restoring Cake…</p></main>;
  if (changes.path !== undefined) return <ChangeExplorer store={changes} reviews={reviews} browse={browse} chat={store} onClose={returnToChat} />;
  if (browse.path !== undefined) return <WorkspaceBrowser store={browse} reviews={reviews} chat={store} onClose={returnToChat} />;

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${store.commandPane ? "right-pane-open" : ""} ${resizingPanel ? "is-resizing" : ""}`} style={{ "--sidebar-width": `${Math.min(sidebarWidth, sidebarMax)}px`, "--right-pane-width": `${Math.min(commandPaneWidth, commandPaneMax)}px` } as CSSProperties}>
      <Sidebar store={sidebar} chat={store} reviews={reviews} settingsOpen={page === "settings"} globalChatOpen={page === "global"} onToggle={() => setSidebarCollapsed((value) => !value)} onOpenSettings={() => navigation.openSettings()} onOpenChat={returnToChat} onOpenGlobalChat={() => { browse.close(); changes.close(); navigation.openGlobalChat(); }} onReloadPi={() => void settings.reloadPi()} />
      {!sidebarCollapsed && <PanelResizeHandle className="sidebar-resize-handle" label="Resize project sidebar" value={sidebarWidth} min={220} max={sidebarMax} edge="left" onChange={setSidebarWidth} onResizeStart={() => setResizingPanel(true)} onResizeEnd={() => setResizingPanel(false)} />}
      <section className="workspace" data-session-id={store.session?.sessionId}>
        <button className={page === "settings" ? "workspace-settings-icon active" : "workspace-settings-icon"} type="button" aria-label="Open settings" aria-current={page === "settings" ? "page" : undefined} onClick={() => navigation.openSettings()}><SettingsIcon /></button>
        <header className="workspace-header"><div><button className="header-sidebar-toggle" aria-label="Toggle sidebar" onClick={() => setSidebarCollapsed((value) => !value)}><SidebarIcon /></button>{page === "settings" && <button className="header-back" aria-label="Back to chat" onClick={returnToChat}><BackIcon /></button>}<strong>{page === "settings" ? "Settings" : page === "global" ? "Global chat" : extensionUi.title ?? (store.session ? store.sessionTitle : "Cake")}</strong>{page === "chat" && store.projectPath && <span>{store.projectPath}</span>}</div>{globalChat ? <Button variant="ghost" size="sm" onClick={() => { if (window.confirm("Clear global chat history?")) void globalChat.clear(); }}>Clear</Button> : page === "chat" && store.session && <div className="header-pane-actions"><button className="header-pane-toggle" type="button" aria-label="Browse project files" onClick={() => void store.openWorkspaceBrowser()}><BrowseIcon /><span>Browse</span></button><button className="header-pane-toggle" type="button" aria-label="Open workspace changes" onClick={() => void store.openSessionChanges()}><ChangesIcon /><span>Changes</span>{changes.changes.length > 0 && <b>{changes.changes.length}</b>}</button></div>}</header>
        {page === "settings" ? <SettingsPage store={store} settings={settings} configuration={chatConfiguration} /> : globalChat ? <GlobalChatPanel store={globalChat} configuration={root.globalChatConfigurationStore} transcriptView={root.globalTranscriptViewStore} /> : !store.session ? (
          <div className="welcome"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build?</h1><p>Open a project for durable workspace chats, or start a one-off chat from your home directory.</p><div><Button size="lg" disabled={store.piState !== "ready" || store.isBusy} onClick={() => void store.chooseProject()}><FolderIcon /> Open project</Button><Button size="lg" variant="outline" disabled={store.piState !== "ready" || store.isBusy} onClick={() => void store.startOneOffChat()}><ChatIcon /> One-off chat</Button></div>{store.error && <ErrorNotice title="Operation failed" message={store.error} details={store.errorDetails} />}</div>
        ) : (
          <div className="workbench"><div className="chat-layout"><Transcript sessionId={store.session.sessionId} parts={root.messageComposerStore.parts} isStreaming={store.isStreaming} hideThinking={store.session.piSettings?.hideThinkingBlock} behavior={{ thinkingExpanded: root.mainTranscriptViewStore.thinkingExpanded, onToggleThinking: () => { root.mainTranscriptViewStore.toggleThinking(); store.persistViewState(); }, onFork: (entryId) => { void store.forkAt(entryId); }, onOpenReviewRun: (threadId) => { void store.openSessionChanges(threadId); }, messageComments: root.messageCommentsStore, inlineWidgets: { store: root.inlineWidgetStore, workspacePath: store.session.workspacePath, sessionId: store.session.sessionId, model: store.session.model }, artifacts: { records: store.artifacts, interaction: artifactInteractions } }} empty={<div className="chat-empty"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build in <em>{store.projectName}</em>?</h1><p>Describe a task, ask a question, or type <code>/</code> for commands.</p></div>} footer={<ArtifactsPanel store={store} artifacts={artifactInteractions} inlineWidgets={root.inlineWidgetStore} />} error={store.error} errorDetails={store.errorDetails} /><ComposerPanel store={store} composer={root.messageComposerStore} reviews={reviews} configuration={chatConfiguration} extensionUi={extensionUi} /></div></div>
        )}
      </section>
      <CommandPane store={store} extensionUi={extensionUi} />
      {store.commandPane && <PanelResizeHandle className="command-pane-resize-handle" label="Resize command pane" value={commandPaneWidth} min={320} max={commandPaneMax} edge="right" onChange={setCommandPaneWidth} onResizeStart={() => setResizingPanel(true)} onResizeEnd={() => setResizingPanel(false)} />}
      {store.pendingTrustPath && <div className="dialog-backdrop"><Confirmation state="requested" role="alertdialog" aria-labelledby="trust-title" aria-describedby="trust-description"><ConfirmationRequest><ConfirmationTitle id="trust-title">Trust this workspace?</ConfirmationTitle><ConfirmationDescription id="trust-description">{store.pendingTrustPath} contains project-local executable Pi resources. Trust it only if you know its contents.</ConfirmationDescription><ConfirmationActions><ConfirmationAction variant="outline" onClick={() => void store.resolveProjectTrust(false)}>Cancel</ConfirmationAction><ConfirmationAction onClick={() => void store.resolveProjectTrust(true)}>Trust and open</ConfirmationAction></ConfirmationActions></ConfirmationRequest></Confirmation></div>}
      {extensionUi.request && <div className="dialog-backdrop"><UiDialog key={extensionUi.request.uiRequestId} request={extensionUi.request} extensionUi={extensionUi} /></div>}
      {extensionUi.notifications.length > 0 && <div className="extension-notifications" aria-live="polite">{extensionUi.notifications.map((notification) => <button key={notification.id} className={`notice notice-${notification.tone}`} onClick={() => extensionUi.dismissNotification(notification.id)}><strong>Extension</strong><span>{notification.message}</span></button>)}</div>}
      {(store.piState === "failed" || store.piState === "stopped") && store.projectPath && <div className="agent-recovery"><span>Pi runtime stopped.</span><Button size="sm" onClick={() => void store.restartPi()}>Restart and reopen</Button></div>}
    </main>
  );
});
