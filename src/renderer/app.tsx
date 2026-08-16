import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { observer, StoreProvider, useStore } from "r-state-tree/react";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationDescription,
  ConfirmationRequest,
  ConfirmationTitle
} from "@/components/ai-elements/confirmation";
import { Conversation, VirtualizedConversation, type VirtualizedConversationHandle } from "@/components/ai-elements/conversation";
import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageLabel } from "@/components/ai-elements/message";
import { CompactionMessage } from "@/components/compaction-message";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Source } from "@/components/ai-elements/source";
import { Tool } from "@/components/ai-elements/tool";
import { diffStats } from "@/components/ai-elements/diff-view";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { ArtifactHost, downloadArtifactMarkdown } from "@/components/artifact-host";
import { ChangeExplorer } from "@/components/change-explorer";
import { WorkspaceBrowser } from "@/components/workspace-browser";
import { SettingsPage } from "@/components/settings-page";
import { SessionTree } from "@/components/session-tree";
import { PanelResizeHandle } from "@/components/panel-resize-handle";
import { CopyErrorDetailsButton } from "@/components/copy-error-details-button";
import { FullscreenButton, FullscreenSurface } from "@/components/fullscreen-surface";
import { MessageCommentDraftPopover, MessageCommentThreadPopover, MessageSelectionAction, type MessageCommentAnchorRect } from "@/components/message-comment-popover";
import { Chat, ChatTextMessage, chatWorkIsActive } from "@/components/chat";
import type { CompatibilityResource, UiPart } from "../ipc/session-contract";
import type { ProjectWorkbenchStore } from "./stores/ProjectWorkbenchStore";
import type { ProjectSessionStore } from "./stores/ProjectSessionStore";
import type { ProjectCatalogStore } from "./stores/ProjectCatalogStore";
import type { ReviewsStore } from "./stores/ReviewsStore";
import type { SidebarStore } from "./stores/SidebarStore";
import { RootStore } from "./stores/RootStore";
import type { ExtensionUiStore, UiRequestState } from "./stores/ExtensionUiStore";
import type { ArtifactInteractionStore } from "./stores/ArtifactInteractionStore";
import type { InlineWidgetStore } from "./stores/InlineWidgetStore";
import type { GlobalChatStore } from "./stores/GlobalChatStore";
import type { AppSelection } from "./stores/AppShellStore";
import type { MessageCommentsStore, MessageSelectionAnchor } from "./stores/MessageCommentsStore";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import { Slot } from "./plugin-runtime";

function ProjectSessionPluginRail({ side }: { side: "left" | "right" }) {
  return <aside className={`project-session-plugin-rail project-session-plugin-rail-${side}`} aria-label={`${side === "left" ? "Left" : "Right"} session plugins`}>
    <div className="plugin-slot project-session-rail-slot project-session-rail-slot-top"><Slot name={`project-session.${side}.top`} /></div>
    <div className="plugin-slot project-session-rail-slot project-session-rail-slot-middle"><Slot name={`project-session.${side}.middle`} /></div>
    <div className="plugin-slot project-session-rail-slot project-session-rail-slot-bottom"><Slot name={`project-session.${side}.bottom`} /></div>
  </aside>;
}

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

const FolderIcon = () => <Icon><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" /></Icon>;
const PlusIcon = () => <Icon><path d="M12 5v14M5 12h14" /></Icon>;
const ChatIcon = () => <Icon><path d="M20 15a3 3 0 0 1-3 3H8l-5 3 1.7-5.1A7 7 0 0 1 4 13V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" /></Icon>;
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
const BrowseIcon = () => <Icon size={15}><path d="M4 5.5h6l1.8 2H20v11H4z" /><path d="M4 9h16" /></Icon>;
const compatibilityResourceKinds: CompatibilityResource["kind"][] = ["extension", "skill", "prompt", "package"];

function CommandPane({ store, extensionUi }: { store: ProjectWorkbenchStore; extensionUi: ExtensionUiStore }) {
  if (!store.commandPane || !store.session) return null;
  const title = store.commandPane === "tree" ? "Session tree" : store.commandPane === "changelog" ? "Pi changelog" : "Pi resources";
  const resourceGroups = store.commandPane === "resources"
    ? compatibilityResourceKinds.map((kind) => ({ kind, resources: store.session!.compatibility.resources.filter((item) => item.kind === kind) }))
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
            ? store.changelogLoading ? <LoadingState label="Loading changelog" /> : <Markdown className="pi-changelog">{store.changelogMarkdown || "No changelog entries found."}</Markdown>
            : <div className="resource-catalog">{diagnostics.length > 0 && <section className="resource-diagnostics"><h3>Diagnostics</h3>{diagnostics.map((item) => <div key={item.id} className={`notice notice-${item.severity}`}><strong>{item.method ?? item.source}</strong><span>{item.message}{item.path ? `\n${item.path}` : ""}</span></div>)}</section>}{resourceGroups.map((group) => <section key={group.kind}><h3>{group.kind[0]!.toUpperCase() + group.kind.slice(1)}s <span>{group.resources.length}</span></h3>{group.resources.length === 0 ? <p>None discovered.</p> : group.resources.map((resource) => <article key={resource.id}><div><strong>{resource.name}</strong><small>{resource.scope} · {resource.origin}</small></div>{resource.description && <p>{resource.description}</p>}{resource.commands.length > 0 && <p><b>Commands</b> {resource.commands.map((command) => `/${command}`).join(", ")}</p>}{resource.tools.length > 0 && <p><b>Tools</b> {resource.tools.join(", ")}</p>}<code title={resource.path}>{resource.source}</code></article>)}</section>)}</div>}
    </aside>
  );
}

const messageHighlightRanges = new Map<string, Range[]>();

type HighlightValue = { readonly priority?: number };

function refreshMessageHighlights() {
  // SAFETY: CSS.highlights is feature-detected before use; TypeScript's DOM
  // declarations do not yet expose the experimental registry consistently.
  const registry = Reflect.get(globalThis.CSS ?? {}, "highlights") as { set(name: string, value: HighlightValue): void; delete(name: string): void } | undefined;
  // SAFETY: the experimental Highlight constructor is feature-detected and is
  // invoked only with DOM Range instances.
  const HighlightConstructor = Reflect.get(globalThis, "Highlight") as (new (...ranges: Range[]) => HighlightValue) | undefined;
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

  const scheduleSelectionAction = (container: HTMLElement | null = contentRef.current) => {
    window.clearTimeout(selectionTimer.current);
    setSelectionAction(undefined);
    if (!behavior.messageComments || part.status === "streaming" || !container) return;
    const captured = captureMessageSelection(container, part.id, part.entryId);
    const selection = window.getSelection();
    if (!captured || !selection?.rangeCount) return;
    const rect = plainRect(selection.getRangeAt(0).getBoundingClientRect());
    selectionTimer.current = window.setTimeout(() => {
      if (window.getSelection()?.toString().trim() === captured.selectedText) setSelectionAction({ selection: captured, rect });
    }, MESSAGE_COMMENT_SELECTION_DELAY_MS);
  };

  const activeThread = openThread ? commentThreads.find((thread) => thread.id === openThread.id) : undefined;

  return (
    <ChatTextMessage ref={messageRef} part={part} contentRef={contentRef} onMouseUp={() => scheduleSelectionAction()}>
      <FullscreenButton className="assistant-message-expand" label="View response fullscreen" onClick={() => setFullscreen(true)} />
      {commentThreads.map((thread, index) => markerPositions[thread.id] && <button key={thread.id} className="message-comment-marker" style={markerPositions[thread.id]} type="button" aria-label={`Open selection chat ${index + 1}`} title={thread.anchor.selectedText} onClick={(event) => setOpenThread({ id: thread.id, anchor: event.currentTarget })}><ChatIcon /><b>{thread.messages.length}</b></button>)}
      {selectionAction && <MessageSelectionAction rect={selectionAction.rect} onChat={(anchor) => { behavior.messageComments?.prepareDraft(selectionAction.selection); setDraft({ selection: selectionAction.selection, anchor }); setSelectionAction(undefined); }} />}
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
      {fullscreen && <FullscreenSurface eyebrow="Full response" title="Cake" onClose={closeFullscreen} onContentMouseUp={(event) => scheduleSelectionAction(event.currentTarget)}>{content()}</FullscreenSurface>}
    </ChatTextMessage>
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
    return <ChatTextMessage part={part} />;
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
  if (part.kind === "compaction") return <CompactionMessage part={part} />;
  return <div className={`notice notice-${part.tone}`} role={part.tone === "error" ? "alert" : "status"}><strong>{part.title}</strong>{part.detail && <span>{part.detail}</span>}</div>;
});

type TranscriptItem = UiPart | { kind: "activity-group"; id: string; parts: UiPart[] } | { kind: "loading-state"; id: string };

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
      {run.status === "running" && <LoadingState label={label} variant="Dots" />}
      {run.status !== "running" && <strong>{label}</strong>}<span>View in Changes</span>
    </button>
  </Message>;
}

const TranscriptList = forwardRef<HTMLDivElement, ComponentProps<"div">>(function TranscriptList({ className, ...props }, ref) {
  return <div ref={ref} className={`transcript-list ${className ?? ""}`} aria-label="Conversation" {...props} />;
});

function ErrorNotice({ title, message, details = message }: { title: string; message: string; details?: string }) {
  return <div className="notice notice-error" role="alert"><strong>{title}</strong><span>{message}</span><CopyErrorDetailsButton details={details} /></div>;
}

export const Transcript = observer(function Transcript({ parts, sessionId, isStreaming, isSubmitting = false, hideThinking = false, behavior, empty, footer, error, errorDetails, errorTitle = "Operation failed" }: { parts: UiPart[]; sessionId: string; isStreaming: boolean; isSubmitting?: boolean; hideThinking?: boolean; behavior: TranscriptBehavior; empty: ReactNode; footer?: ReactNode; error?: string; errorDetails?: string; errorTitle?: string }) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const visibleParts = hideThinking ? parts.filter((part) => part.kind !== "reasoning") : parts;
  const showAssistantLoading = chatWorkIsActive(parts, isStreaming, isSubmitting);
  const items: TranscriptItem[] = [
    ...groupTranscriptParts(visibleParts),
    ...(showAssistantLoading ? [{ kind: "loading-state" as const, id: "loading-state" }] : [])
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
        <Conversation>{empty}{showAssistantLoading && <LoadingState />}{footer}{error && <ErrorNotice title={errorTitle} message={error} details={errorDetails} />}</Conversation>
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
      itemContent={(index, item) => <div className={`transcript-item${errorNoticeFollowsUser(items, index) ? " transcript-item-error-after-user" : ""}`}>{item.kind === "activity-group" ? <ActivityGroup parts={item.parts} behavior={behavior} isStreaming={isStreaming} /> : item.kind === "loading-state" ? <LoadingState /> : item.kind === "review-run" ? <ReviewRunMessage run={item} onOpen={behavior.onOpenReviewRun} /> : <TranscriptPart part={item} behavior={behavior} />}</div>}
    />
  );
});

const ArtifactsPanel = observer(function ArtifactsPanel({ session, inlineWidgets }: { session: ProjectSessionStore; inlineWidgets: InlineWidgetStore }) {
  const artifacts = session.artifactInteractionStore;
  const records = session.model.artifacts.map((artifact) => artifact.value);
  if (records.length === 0) return null;
  const linked = new Set(session.canonicalParts.flatMap((part) => part.kind === "tool" && part.artifactId ? [part.artifactId] : []));
  const unlinked = records.filter((record) => !linked.has(record.artifact.id));
  return <section className="artifacts-panel" aria-label="Session artifacts">{unlinked.map((record) => { const request = artifacts.request?.record.artifact.id === record.artifact.id ? artifacts.request : undefined; return <ArtifactHost key={record.artifact.id} record={record} requested={Boolean(request)} onSubmit={(value) => void artifacts.respond(value)} onCancel={() => void artifacts.respond(undefined, true)} inlineWidgets={inlineWidgets} />; })}<details className="artifacts-index"><summary>{records.length} session {records.length === 1 ? "artifact" : "artifacts"}</summary><div><Button variant="ghost" size="sm" onClick={() => { void artifacts.exportMarkdown().then(downloadArtifactMarkdown); }}>Export Markdown</Button>{records.map((record) => <span key={record.artifact.id}>{record.artifact.title ?? record.artifact.id} <small>{record.artifact.kind} · r{record.artifact.revision}</small></span>)}</div></details></section>;
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

export const Sidebar = observer(function Sidebar({ store, projects, chat, cakeChat, reviews, selection, onOpenSettings, onOpenCakeChat, onCreateCakeChat, onOpenSession, onCreateSession, onStartOneOffChat, onChooseProject, onToggle, onReloadPi }: { store: SidebarStore; projects: ProjectCatalogStore; chat: ProjectWorkbenchStore; cakeChat: GlobalChatStore; reviews: ReviewsStore; selection: AppSelection; onOpenSettings: () => void; onOpenCakeChat(sessionId?: string): void; onCreateCakeChat(): void; onOpenSession(workspacePath: string, sessionId: string): void; onCreateSession(workspacePath: string): void; onStartOneOffChat(): void; onChooseProject(): void; onToggle: () => void; onReloadPi?: () => void }) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
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
  const cakeChatSelected = (sessionId?: string) => selection.kind === "cake-chat" && selection.sessionId === sessionId;
  const projectSessionSelected = (workspacePath: string, sessionId: string) => selection.kind === "project-session" && selection.workspacePath === workspacePath && selection.sessionId === sessionId;
  return (
    <aside className="sidebar">
      <div className="sidebar-window-tools"><button aria-label="Toggle sidebar" onClick={onToggle}><SidebarIcon /></button><button aria-label="Back" disabled><BackIcon /></button><button aria-label="Forward" disabled><ForwardIcon /></button></div>
      <div className="sidebar-brand"><details className="brand-menu"><summary><span>🍰 Cake Chat</span><ChevronIcon /></summary><div className="brand-dropdown"><button type="button" disabled={!chat.session || !onReloadPi} onClick={(event) => { onReloadPi?.(); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Reload Pi<span>{chat.session?.piSettings?.reloadPending ? "Queued" : "Settings and resources"}</span></button></div></details><div className="brand-actions"><button aria-label="New Cake Chat" onClick={onCreateCakeChat}><PlusIcon /></button></div></div>
      <div className="plugin-slot plugin-slot-sidebar-header"><Slot name="global.sidebar.header" /></div>
      <div className="sidebar-scroll">
        <div className="project-group cake-chat-sessions">
          {cakeChat.summaries.map((session) => <div key={session.id} data-session-id={session.id} className={`session-item ${cakeChatSelected(session.id) ? "active" : ""}`}><button className="session-row" aria-current={cakeChatSelected(session.id) ? "page" : undefined} onClick={() => onOpenCakeChat(session.id)}><span className="session-title" title={session.title}>{session.title}</span><time className="session-time" dateTime={session.modified} title={new Date(session.modified).toLocaleString()}>{store.sessionActivityTime(session.modified)}</time>{cakeChat.findSession(session.id)?.streaming && <i className="session-status session-status-running" role="img" aria-label="Running" title="Running" />}</button></div>)}
          {cakeChat.summaries.length === 0 && <button className={`new-chat cake-chat-link${cakeChatSelected() ? " active" : ""}`} aria-current={cakeChatSelected() ? "page" : undefined} onClick={() => onOpenCakeChat()}><span className="cake-mini-mark">C</span><span>Open Cake Chat</span></button>}
        </div>
        <button className="new-chat" onClick={onStartOneOffChat}><ChatIcon /><span>New chat</span></button>
        <div className="section-heading projects-heading"><span>Projects</span><div><span className="project-options" aria-hidden="true"><MoreIcon /></span><button aria-label="Add project" onClick={onChooseProject}><PlusIcon /></button></div></div>
        {projects.recentProjectPaths.length === 0 ? <p className="sidebar-empty">Add a folder to start a project.</p> : projects.recentProjectPaths.map((path) => {
          const collapsed = collapsedProjects.has(path);
          const sessions = store.projectSessions(path);
          const visibleSessions = sessions.slice(0, store.sessionLimit(path));
          return <div className="project-group" key={path}>
            <div className="project-row" title={path}><button className="project-label" type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${projects.nameForPath(path)}`} onClick={() => toggleProject(path)}><span className={`project-disclosure ${collapsed ? "collapsed" : ""}`}><ChevronIcon /></span><FolderIcon /><span>{projects.nameForPath(path)}</span></button><button className="project-add" aria-label={`New chat in ${projects.nameFromPath(path)}`} onClick={() => onCreateSession(path)}><PlusIcon /></button></div>
            {!collapsed && visibleSessions.map((session) => {
              const actionableCommentCount = reviews.chatCommentCountForSession(path, session.id);
              return <div key={session.id} data-session-id={session.id} className={`session-item ${projectSessionSelected(path, session.id) ? "active" : ""}`}><button className="session-row" aria-current={projectSessionSelected(path, session.id) ? "page" : undefined} onClick={() => onOpenSession(path, session.id)} onContextMenu={(event) => renameSession(event, path, session.id, session.title)}><span className="session-title" title={session.title}>{session.title}</span><time className="session-time" dateTime={session.modified} title={new Date(session.modified).toLocaleString()}>{store.sessionActivityTime(session.modified)}</time>{actionableCommentCount > 0 && <b className="session-review-count">{actionableCommentCount} {actionableCommentCount === 1 ? "comment" : "comments"}</b>}{activityIndicator(path, session.id)}</button></div>;
            })}
            {!collapsed && sessions.length > visibleSessions.length && <button className="session-more" onClick={() => store.showMoreSessions(path)}>Show more</button>}
          </div>;
        })}
      </div>
      <div className="sidebar-footer">
        <div className="plugin-slot plugin-slot-sidebar-footer"><Slot name="global.sidebar.footer" /></div>
        <button className={selection.kind === "settings" ? "sidebar-settings-icon active" : "sidebar-settings-icon"} type="button" aria-label="Open settings" aria-current={selection.kind === "settings" ? "page" : undefined} onClick={onOpenSettings}><SettingsIcon /></button>
      </div>
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
  const cakeChatSession = globalChat && shell.selection.kind === "cake-chat" && shell.selection.sessionId
    ? globalChat.findSession(shell.selection.sessionId)
    : undefined;
  const chatError = persistence.error ?? store.error ?? composer?.error ?? reviews.error ?? chatConfiguration?.error ?? extensionUi.error ?? artifactInteractions?.error;
  const chatErrorDetails = persistence.error ? persistence.errorDetails
    : store.error ? store.errorDetails
    : composer?.error ? composer.errorDetails
    : reviews.error ? reviews.errorDetails
    : chatConfiguration?.error ? chatConfiguration.errorDetails
    : extensionUi.error ? extensionUi.errorDetails
    : artifactInteractions?.errorDetails;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(292);
  const [commandPaneWidth, setCommandPaneWidth] = useState(420);
  const [resizingPanel, setResizingPanel] = useState(false);
  const [sessionHeaderHost, setSessionHeaderHost] = useState<HTMLDivElement | null>(null);
  const sidebarMax = Math.max(240, window.innerWidth - (store.commandPane ? commandPaneWidth : 0) - 360);
  const commandPaneMax = Math.max(320, window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth) - 360);
  const returnToWorkbench = useCallback(() => {
    root.showWorkbench();
    store.activeSession?.composerStore.requestFocus();
  }, [root, store]);
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
      if (browse.path !== undefined || changes.path !== undefined) returnToWorkbench();
      else if (store.commandPane) store.closeCommandPane();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [store, browse, changes, returnToWorkbench]);

  if (!persistence.hydrated) return <main className="loading-screen"><span className="cake-mark">C</span><LoadingState label="Restoring Cake" /></main>;
  if (changes.path !== undefined) return <ChangeExplorer store={changes} reviews={reviews} browse={browse} chat={store} onClose={returnToWorkbench} />;
  if (browse.path !== undefined) return <WorkspaceBrowser store={browse} reviews={reviews} chat={store} onClose={returnToWorkbench} />;

  const shellStyle: CSSProperties & Record<"--sidebar-width" | "--right-pane-width", string> = {
    "--sidebar-width": `${Math.min(sidebarWidth, sidebarMax)}px`,
    "--right-pane-width": `${Math.min(commandPaneWidth, commandPaneMax)}px`,
  };
  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${store.commandPane ? "right-pane-open" : ""} ${resizingPanel ? "is-resizing" : ""}`} style={shellStyle}>
      <Sidebar store={sidebar} projects={projects} chat={store} cakeChat={root.globalChatStore} reviews={reviews} selection={shell.selection} onToggle={() => setSidebarCollapsed((value) => !value)} onOpenSettings={() => root.showSettings()} onOpenCakeChat={(sessionId) => { void root.openCakeChat(sessionId); }} onCreateCakeChat={() => { void root.startCakeChat(); }} onOpenSession={(workspacePath, sessionId) => { void root.openSession(workspacePath, sessionId); }} onCreateSession={(workspacePath) => { void root.createSession(workspacePath); }} onStartOneOffChat={() => { void root.startOneOffChat(); }} onChooseProject={() => { void root.chooseProject(); }} onReloadPi={() => void settings.reloadPi()} />
      {!sidebarCollapsed && <PanelResizeHandle className="sidebar-resize-handle" label="Resize project sidebar" value={sidebarWidth} min={220} max={sidebarMax} edge="left" onChange={setSidebarWidth} onResizeStart={() => setResizingPanel(true)} onResizeEnd={() => setResizingPanel(false)} />}
      <section className="workspace" data-session-id={shell.selection.kind === "cake-chat" ? shell.selection.sessionId : shell.selection.kind === "project-session" ? shell.selection.sessionId : undefined}>
        <button className={surface === "settings" ? "workspace-settings-icon active" : "workspace-settings-icon"} type="button" aria-label="Open settings" aria-current={surface === "settings" ? "page" : undefined} onClick={() => root.showSettings()}><SettingsIcon /></button>
        <header className="workspace-header"><div><button className="header-sidebar-toggle" aria-label="Toggle sidebar" onClick={() => setSidebarCollapsed((value) => !value)}><SidebarIcon /></button>{surface === "settings" && <button className="header-back" aria-label="Back to chat" onClick={returnToWorkbench}><BackIcon /></button>}<strong>{surface === "settings" ? "Settings" : surface === "global-chat" ? "Cake Chat" : extensionUi.title ?? (session ? store.sessionTitle : "Cake")}</strong>{surface === "workbench" && store.projectPath && <span>{store.projectPath}</span>}</div><div className="workspace-header-actions" ref={setSessionHeaderHost} /></header>
        {surface === "settings" ? <SettingsPage store={store} settings={settings} configuration={chatConfiguration} customization={root.customizationStore} onViewStateChange={() => persistence.schedule()} /> : globalChat ? cakeChatSession ? <div className="workbench global-chat"><Chat store={cakeChatSession.chatStore} transcript={<Transcript parts={cakeChatSession.chatStore.parts} sessionId={cakeChatSession.chatStore.id} isStreaming={cakeChatSession.chatStore.streaming} isSubmitting={cakeChatSession.chatStore.submitting} hideThinking={cakeChatSession.chatStore.hideThinking} behavior={{ thinkingExpanded: cakeChatSession.chatStore.thinkingExpanded, onToggleThinking: () => cakeChatSession.chatStore.toggleThinking() }} empty={<div className="chat-empty"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What can I help you find or do?</h1><p>Ask about your tasks, open one, or delegate work to it.</p></div>} error={cakeChatSession.chatStore.error?.message} errorDetails={cakeChatSession.chatStore.error?.details} errorTitle={cakeChatSession.chatStore.error?.title} />} /></div> : <div className="loading-screen"><span className="cake-mark">C</span><LoadingState label="Opening Cake Chat" /></div> : !session ? (
          <div className="welcome"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build?</h1><p>Open a project for durable workspace chats, or start a one-off chat from your home directory.</p><div><Button size="lg" disabled={store.piState !== "ready" || store.isBusy} onClick={() => void root.chooseProject()}><FolderIcon /> Open project</Button><Button size="lg" variant="outline" disabled={store.piState !== "ready" || store.isBusy} onClick={() => void root.startOneOffChat()}><ChatIcon /> One-off chat</Button></div>{chatError && <ErrorNotice title="Operation failed" message={chatError} details={chatErrorDetails} />}</div>
        ) : (
          <StoreProvider key={`${session.workspacePath}\u0000${session.sessionId}`} store={session}>
            {sessionHeaderHost && createPortal(<>
                <div className="header-pane-actions"><button className="header-pane-toggle" type="button" aria-label="Browse project files" onClick={() => void store.openWorkspaceBrowser()}><BrowseIcon /><span>Browse</span></button><button className="header-pane-toggle" type="button" aria-label="Open workspace changes" onClick={() => void store.openSessionChanges()}><ChangesIcon /><span>Changes</span>{changes.workingTreeCount > 0 && <b>{changes.workingTreeCount}</b>}</button></div>
                <div className="plugin-slot plugin-slot-project-session-header"><Slot name="project-session.header.actions" /></div>
              </>, sessionHeaderHost)}
            <div className="workbench project-session-workbench">
              <ProjectSessionPluginRail side="left" />
              <Chat store={session.chatStore} transcript={<Transcript sessionId={session.chatStore.id} parts={session.chatStore.parts} isStreaming={session.chatStore.streaming} isSubmitting={session.chatStore.submitting} hideThinking={session.chatStore.hideThinking} behavior={{ thinkingExpanded: session.chatStore.thinkingExpanded, onToggleThinking: () => session.chatStore.toggleThinking(), onFork: (entryId) => { void store.forkAt(entryId); }, onOpenReviewRun: (threadId) => { void store.openSessionChanges(threadId); }, messageComments: session.messageCommentsStore, inlineWidgets: { store: root.inlineWidgetStore, workspacePath: session.workspacePath, sessionId: session.sessionId, model: session.model.model }, artifacts: { records: session.model.artifacts.map((artifact) => artifact.value), interaction: session.artifactInteractionStore } }} empty={<div className="chat-empty"><span className="cake-orbit"><span className="cake-mark">C</span></span><h1>What should we build in <em>{store.projectName}</em>?</h1><p>Describe a task, ask a question, or type <code>/</code> for commands.</p></div>} footer={<><ArtifactsPanel session={session} inlineWidgets={root.inlineWidgetStore} /><Slot name="project-session.transcript.after" /></>} error={chatError} errorDetails={chatErrorDetails} />} composerContent={<>{reviews.chatCommentCount > 0 && <div className="review-context-badge"><button type="button" onClick={() => void store.openSessionChanges()}><span>{reviews.chatCommentCount}</span> {reviews.chatCommentCount === 1 ? "comment ready to send" : "comments ready to send"}</button></div>}<Slot name="project-session.composer.before" /></>} pluginActions={<Slot name="project-session.composer.actions" />} status={<>{extensionUi.statuses.length > 0 && <div className="extension-statuses" role="status">{extensionUi.statuses.map((status) => <span key={status.key}><strong>{status.key}</strong> {status.text}</span>)}</div>}<Slot name="project-session.status" /></>} />
              <ProjectSessionPluginRail side="right" />
            </div>
          </StoreProvider>
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
