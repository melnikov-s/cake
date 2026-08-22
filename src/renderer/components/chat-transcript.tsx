import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { observer } from "r-state-tree/react";
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageContent, MessageLabel } from "@/components/ai-elements/message";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Source } from "@/components/ai-elements/source";
import { Tool, ToolRunTimer } from "@/components/ai-elements/tool";
import { diffStats } from "@/components/ai-elements/diff-view";
import { WorkLogDiff } from "@/components/ai-elements/work-log-diff";
import { ArtifactHost } from "@/components/artifact-host";
import { CompactionMessage } from "@/components/compaction-message";
import { CopyErrorDetailsButton } from "@/components/copy-error-details-button";
import { FullscreenButton, FullscreenSurface } from "@/components/fullscreen-surface";
import { ImagePreview } from "@/components/image-preview";
import { ContextMenu } from "@/components/ui/context-menu";
import { IconButton } from "@/components/ui/icon-button";
import { LoadingState } from "@/components/ui/loading-state";
import {
  MessageCommentDraftPopover,
  MessageCommentThreadPopover,
  type MessageCommentAnchorRect,
} from "@/components/message-comment-popover";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { UiPart } from "../../ipc/session-contract";
import { toolDiff } from "../../utils/turn-diff";
import type { ArtifactInteractionStore } from "../stores/ArtifactInteractionStore";
import type { ChatStore } from "../stores/ChatStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { MessageCommentsStore, MessageSelectionAnchor } from "../stores/MessageCommentsStore";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
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

const ChatIcon = () => (
  <Icon>
    <path d="M20 15a3 3 0 0 1-3 3H8l-5 3 1.7-5.1A7 7 0 0 1 4 13V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" />
  </Icon>
);
const CopyIcon = () => (
  <Icon>
    <rect x="8" y="8" width="11" height="11" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Icon>
);
const ForkIcon = () => (
  <Icon>
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="5" r="2" />
    <circle cx="12" cy="19" r="2" />
    <path d="M6 7v2a4 4 0 0 0 4 4h2M18 7v2a4 4 0 0 1-4 4h-2v4" />
  </Icon>
);
const CheckIcon = () => (
  <Icon>
    <path d="m5 12 4 4L19 6" />
  </Icon>
);
const DiffIcon = () => (
  <Icon>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M12 4v16M7 9h3M8.5 7.5v3M14 9h3M14 15h3" />
  </Icon>
);
const LogIcon = () => (
  <Icon>
    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </Icon>
);

export function chatWorkIsActive(
  parts: UiPart[],
  streaming: boolean,
  submitting: boolean,
  waitingForUser = false,
) {
  if (waitingForUser) return false;
  if (streaming) return true;
  if (!submitting) return false;
  const latestUserIndex = parts.findLastIndex(
    (part) =>
      (part.kind === "text" && part.role === "user") ||
      (part.kind === "attachment" && part.attachmentKind === "image"),
  );
  return latestUserIndex < 0 || latestUserIndex === parts.length - 1;
}

export const ChatTextMessage = forwardRef<
  HTMLElement,
  {
    part: Extract<UiPart, { kind: "text" }>;
    contentRef?: RefObject<HTMLDivElement | null>;
    children?: ReactNode;
    onOpenFilePath?(path: string): void;
  }
>(function ChatTextMessage({ part, contentRef, children, onOpenFilePath }, ref) {
  const assistant = part.role === "assistant";
  // A steered or queued prompt is not yet accepted into the conversation;
  // render it with a distinct pending treatment until Pi delivers it.
  const pending =
    !assistant && (part.deliveryState === "queued" || part.deliveryState === "steering");
  const userLabel =
    part.deliveryState === "queued"
      ? "You · pending"
      : part.deliveryState === "steering"
        ? "You · pending steer"
        : part.deliveryState === "sending"
          ? "You · sending"
          : "You";
  return (
    <Message
      ref={ref}
      className={[
        assistant ? "assistant-message mr-auto w-full" : "ml-auto w-[min(88%,42rem)]",
        pending ? "user-message-pending" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <MessageLabel>
        {assistant ? (part.status === "streaming" ? "Cake · working" : "Cake") : userLabel}
      </MessageLabel>
      <MessageContent
        ref={contentRef}
        className={assistant ? "assistant-message-content" : "user-message"}
      >
        <Markdown onOpenFilePath={onOpenFilePath}>{part.text}</Markdown>
      </MessageContent>
      {children}
    </Message>
  );
});

const messageHighlightRanges = new Map<string, Range[]>();

type HighlightValue = { readonly priority?: number };
type HighlightRegistry = {
  set(name: string, value: HighlightValue): void;
  delete(name: string): void;
};
type HighlightConstructor = new (...ranges: Range[]) => HighlightValue;

function refreshMessageHighlights() {
  // SAFETY: CSS.highlights is feature-detected before use; TypeScript's DOM
  // declarations do not yet expose the experimental registry consistently.
  const css = globalThis.CSS;
  // SAFETY: the guarded CSS object may expose the experimental HighlightRegistry.
  const registry = css
    ? (css as typeof globalThis.CSS & { highlights?: HighlightRegistry }).highlights
    : undefined;
  // SAFETY: the experimental Highlight constructor is feature-detected and is
  // invoked only with DOM Range instances.
  const HighlightClass = (globalThis as typeof globalThis & { Highlight?: HighlightConstructor })
    .Highlight;
  if (!registry || !HighlightClass) return;
  if (!document.getElementById("cake-message-comment-highlight-style")) {
    const style = document.createElement("style");
    style.id = "cake-message-comment-highlight-style";
    style.textContent =
      "::highlight(cake-message-comment){background:color-mix(in oklab,var(--accent) 28%,transparent);text-decoration:underline;text-decoration-color:color-mix(in oklab,var(--accent) 75%,transparent);text-decoration-thickness:2px;text-underline-offset:2px}";
    document.head.appendChild(style);
  }
  const ranges = [...messageHighlightRanges.values()].flat();
  if (ranges.length === 0) registry.delete("cake-message-comment");
  else registry.set("cake-message-comment", new HighlightClass(...ranges));
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
    if (!startPoint && start <= traversed + length)
      startPoint = { node, offset: Math.max(0, start - traversed) };
    if (end <= traversed + length) {
      endPoint = { node, offset: Math.max(0, end - traversed) };
      break;
    }
    traversed += length;
  }
  if (!startPoint || !endPoint) return undefined;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

export function captureMessageSelection(
  container: HTMLElement,
  messageId: string,
  entryId?: string,
): MessageSelectionAnchor | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  // Clamp the browser range into the container so selections that spill across
  // message boundaries still produce a well-formed anchor for the first part.
  const range = selection.getRangeAt(0).cloneRange();
  if (!container.contains(range.startContainer)) range.setStart(container, 0);
  if (!container.contains(range.endContainer)) range.setEnd(container, container.childNodes.length);
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
    contextAfter: text.slice(endOffset, endOffset + 320),
  };
}

function plainRect(rect: DOMRect): MessageCommentAnchorRect {
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}

function selectionEndRect(range: Range) {
  return Array.from(range.getClientRects()).at(-1) ?? range.getBoundingClientRect();
}

export interface TranscriptSelectionCapture {
  selection: MessageSelectionAnchor;
  rect: MessageCommentAnchorRect;
  x: number;
  y: number;
}

/** Resolves the active browser selection against the parts this transcript
 *  owns, so every selectable surface (user messages, assistant replies, code,
 *  work logs, artifacts) can be right-clicked into a selection chat. */
export function captureTranscriptSelection(
  parts: UiPart[],
  cursor: { x: number; y: number },
): TranscriptSelectionCapture | undefined {
  const browser = window.getSelection();
  if (!browser || browser.rangeCount === 0 || browser.isCollapsed) return undefined;
  const range = browser.getRangeAt(0);
  const startElement =
    range.startContainer instanceof HTMLElement
      ? range.startContainer
      : range.startContainer.parentElement;
  const partElement = startElement?.closest<HTMLElement>("[data-part-id]");
  const partId = partElement?.dataset.partId;
  const part = partId ? parts.find((candidate) => candidate.id === partId) : undefined;
  if (!partId || !part) return undefined;
  // Offsets inside streaming text are unstable, so ignore those selections.
  if (part.kind === "text" && part.status === "streaming") return undefined;
  const container =
    partElement.querySelector<HTMLElement>(".assistant-message-content, .user-message") ??
    partElement;
  const selection = captureMessageSelection(
    container,
    partId,
    part.kind === "text" ? part.entryId : undefined,
  );
  if (!selection) return undefined;
  return { selection, rect: plainRect(selectionEndRect(range)), x: cursor.x, y: cursor.y };
}

export interface ChatTranscriptBehavior {
  onFork?(entryId: string): void;
  onOpenReviewRun?(threadId?: string): void;
  openFileInEditor?(path: string): void | Promise<void>;
  /** Opens a workspace-relative file path mentioned in a message inside the project's Browse view. */
  openFilePath?(path: string): void;
  waitingForUser?: boolean;
  inlineWidgets?: InlineWidgetStore;
  artifacts?: { records: ArtifactRecord[]; interaction: ArtifactInteractionStore };
  messageComments?: MessageCommentsStore;
}

interface CanonicalTranscriptBehavior extends ChatTranscriptBehavior {
  store: ChatStore;
  workLogDiff: boolean;
  onToggleWorkLogDiff(): void;
  renderChat(store: ChatStore): ReactNode;
}

const AssistantTextMessage = observer(function AssistantTextMessage({
  part,
  behavior,
}: {
  part: Extract<UiPart, { kind: "text" }>;
  behavior: CanonicalTranscriptBehavior;
}) {
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [openThread, setOpenThread] = useState<{
    id: string;
    anchor: HTMLElement | MessageCommentAnchorRect;
  }>();
  const [markerPositions, setMarkerPositions] = useState<
    Record<string, { left: number; top: number }>
  >({});
  const messageRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const commentThreads = behavior.messageComments?.threadsForMessage(part.id) ?? [];
  const closeFullscreen = useCallback(() => setFullscreen(false), []);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const content = () => <Markdown onOpenFilePath={behavior.openFilePath}>{part.text}</Markdown>;

  useLayoutEffect(() => {
    const key = `${part.id}:${part.entryId ?? ""}`;
    const container = contentRef.current;
    const ranges = container
      ? commentThreads.flatMap((thread) => {
          const start = thread.anchor.startOffset;
          const end = thread.anchor.endOffset;
          if (start === undefined || end === undefined) return [];
          const range = rangeAtOffsets(container, start, end);
          return range ? [range] : [];
        })
      : [];
    messageHighlightRanges.set(key, ranges);
    refreshMessageHighlights();
    return () => {
      messageHighlightRanges.delete(key);
      refreshMessageHighlights();
    };
  }, [
    part.id,
    part.entryId,
    part.text,
    commentThreads.map((thread) => `${thread.id}:${thread.updatedAt}`).join("|"),
  ]);

  useLayoutEffect(() => {
    const message = messageRef.current;
    const contentNode = contentRef.current;
    if (!message || !contentNode) return;
    const update = () => {
      const messageRect = message.getBoundingClientRect();
      const next: Record<string, { left: number; top: number }> = {};
      for (const thread of commentThreads) {
        const start = thread.anchor.startOffset;
        const end = thread.anchor.endOffset;
        if (start === undefined || end === undefined) continue;
        const range = rangeAtOffsets(contentNode, start, end);
        const rangeRects = range ? Array.from(range.getClientRects()) : [];
        const rect = rangeRects.at(-1) ?? range?.getBoundingClientRect();
        if (!rect) continue;
        next[thread.id] = {
          left: Math.min(
            Math.max(8, rect.right - messageRect.left + 7),
            Math.max(8, messageRect.width - 30),
          ),
          top: rect.top - messageRect.top + rect.height / 2,
        };
      }
      setMarkerPositions(next);
    };
    update();
    const resizeObserver =
      "ResizeObserver" in globalThis ? new globalThis.ResizeObserver(update) : undefined;
    resizeObserver?.observe(contentNode);
    window.addEventListener("resize", update);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [
    part.text,
    commentThreads
      .map((thread) => `${thread.id}:${thread.anchor.startOffset}:${thread.anchor.endOffset}`)
      .join("|"),
  ]);

  const activeThread = openThread
    ? commentThreads.find((thread) => thread.id === openThread.id)
    : undefined;

  return (
    <ChatTextMessage
      ref={messageRef}
      part={part}
      contentRef={contentRef}
      onOpenFilePath={behavior.openFilePath}
    >
      <FullscreenButton
        className="assistant-message-expand"
        label="View response fullscreen"
        onClick={() => setFullscreen(true)}
      />
      {commentThreads.map(
        (thread, index) =>
          markerPositions[thread.id] && (
            <IconButton
              key={thread.id}
              className="message-comment-marker"
              style={markerPositions[thread.id]}
              tooltip={thread.anchor.selectedText}
              ariaLabel={`Open selection chat ${index + 1}`}
              onClick={(event) => setOpenThread({ id: thread.id, anchor: event.currentTarget })}
            >
              <ChatIcon />
              <b>{thread.messageCount}</b>
            </IconButton>
          ),
      )}
      {activeThread && behavior.messageComments && (
        <MessageCommentThreadPopover
          anchor={openThread!.anchor}
          thread={activeThread}
          store={behavior.messageComments}
          renderChat={behavior.renderChat}
          onClose={() => setOpenThread(undefined)}
        />
      )}
      {part.status !== "streaming" && (
        <div className="assistant-message-actions" aria-label="Message actions">
          <IconButton
            tooltip={copied ? "Copied" : "Copy response"}
            ariaLabel={copied ? "Copied response" : "Copy response"}
            onClick={() =>
              void navigator.clipboard.writeText(part.text).then(() => setCopied(true))
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
          {part.entryId && behavior.onFork && (
            <IconButton
              tooltip="Fork into new chat"
              ariaLabel="Fork response into new chat"
              onClick={() => behavior.onFork!(part.entryId!)}
            >
              <ForkIcon />
            </IconButton>
          )}
        </div>
      )}
      {fullscreen && (
        <FullscreenSurface eyebrow="Full response" title="Cake" onClose={closeFullscreen}>
          <div className="transcript-part" data-part-id={part.id}>
            {content()}
          </div>
        </FullscreenSurface>
      )}
    </ChatTextMessage>
  );
});

// Observer-wrapped: reads ChatStore.workLogItemOpen (per-item overrides plus the
// global expansion mode), so item clicks must re-render this component even when
// the rest of the transcript is idle.
const TranscriptPartContent = observer(function TranscriptPartContent({
  part,
  behavior,
  workLogItem = false,
}: {
  part: UiPart;
  behavior: CanonicalTranscriptBehavior;
  /** True when rendered inside a work log, so item expansion follows the global mode. */
  workLogItem?: boolean;
}) {
  if (part.kind === "text")
    return part.role === "assistant" ? (
      <AssistantTextMessage part={part} behavior={behavior} />
    ) : (
      <ChatTextMessage part={part} onOpenFilePath={behavior.openFilePath} />
    );
  if (part.kind === "reasoning")
    return (
      <Reasoning
        open={behavior.store.workLogItemOpen(part.id)}
        onToggle={() =>
          behavior.store.setWorkLogItemOpen(part.id, !behavior.store.workLogItemOpen(part.id))
        }
        streaming={part.status === "streaming"}
        hasContent={Boolean(part.text.trim())}
      >
        <Markdown onOpenFilePath={behavior.openFilePath}>{part.text}</Markdown>
      </Reasoning>
    );
  if (part.kind === "tool") {
    const record = part.artifactId
      ? behavior.artifacts?.records.find((candidate) => candidate.artifact.id === part.artifactId)
      : undefined;
    if (record && behavior.artifacts) {
      const request =
        behavior.artifacts.interaction.request?.record.artifact.id === record.artifact.id
          ? behavior.artifacts.interaction.request
          : undefined;
      return (
        <ArtifactHost
          record={record}
          requested={Boolean(request)}
          onSubmit={(value) => void behavior.artifacts!.interaction.answer(record, value)}
          onSkip={() => void behavior.artifacts!.interaction.respond(undefined, true)}
          inlineWidgets={behavior.inlineWidgets}
        />
      );
    }
    return (
      <Tool
        part={part}
        onOpenFile={behavior.openFileInEditor}
        timer={<ToolRunTimer store={behavior.store} partId={part.id} />}
        expansion={
          workLogItem
            ? {
                open: behavior.store.workLogItemOpen(part.id),
                toggle: () =>
                  behavior.store.setWorkLogItemOpen(
                    part.id,
                    !behavior.store.workLogItemOpen(part.id),
                  ),
              }
            : undefined
        }
      />
    );
  }
  if (part.kind === "source") return <Source title={part.title} url={part.url} />;
  if (part.kind === "attachment")
    return part.attachmentKind === "image" && part.data ? (
      <figure className="transcript-image">
        <ImagePreview
          src={`data:${part.mediaType};base64,${part.data}`}
          alt={part.name}
          caption={part.name}
        />
        <figcaption>{part.name}</figcaption>
      </figure>
    ) : (
      <div className="w-fit rounded-full border border-border px-3 py-1 font-mono text-[0.68rem]">
        {part.attachmentKind} · {part.name}
      </div>
    );
  if (part.kind === "review-run")
    return <ReviewRunMessage run={part} onOpen={behavior.onOpenReviewRun} />;
  if (part.kind === "compaction") return <CompactionMessage part={part} />;
  return (
    <div className={`notice notice-${part.tone}`} role={part.tone === "error" ? "alert" : "status"}>
      <strong>{part.title}</strong>
      {part.detail && <span>{part.detail}</span>}
    </div>
  );
});

/** Marks every rendered transcript part in the DOM so right-click selection
 *  capture can resolve any selectable surface back to its conversation part.
 *  The wrapper is layout-invisible via `display: contents`. */
function TranscriptPart(props: {
  part: UiPart;
  behavior: CanonicalTranscriptBehavior;
  workLogItem?: boolean;
}) {
  return (
    <div className="transcript-part" data-part-id={props.part.id}>
      <TranscriptPartContent {...props} />
    </div>
  );
}

type TranscriptItem =
  | UiPart
  | { kind: "activity-group"; id: string; parts: UiPart[] }
  | { kind: "loading-state"; id: string };

function errorNoticeFollowsUser(items: TranscriptItem[], index: number) {
  const item = items[index];
  const previous = items[index - 1];
  return (
    item?.kind === "notice" &&
    item.tone === "error" &&
    previous?.kind === "text" &&
    previous.role === "user"
  );
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
    if ((part.kind === "tool" && !part.artifactId) || part.kind === "reasoning")
      activity.push(part);
    else {
      flush();
      items.push(part);
    }
  }
  flush();
  return items;
}

const ActivityGroup = observer(function ActivityGroup({
  parts,
  behavior,
  isStreaming,
}: {
  parts: UiPart[];
  behavior: CanonicalTranscriptBehavior;
  isStreaming: boolean;
}) {
  const open = behavior.store.workLogsExpansion !== "collapsed";
  const logRef = useRef<HTMLDivElement>(null);
  const logIsAtBottomRef = useRef(true);
  const tools = parts.filter((part) => part.kind === "tool").length;
  const reasoningParts = parts.filter(
    (part): part is Extract<UiPart, { kind: "reasoning" }> => part.kind === "reasoning",
  );
  const reasoningHasContent = reasoningParts.some((part) => Boolean(part.text.trim()));
  const reasoningIsStreaming = reasoningParts.some((part) => part.status === "streaming");
  const toolParts = parts.filter(
    (part): part is Extract<UiPart, { kind: "tool" }> => part.kind === "tool",
  );
  const activityIsRunning =
    reasoningIsStreaming || toolParts.some((part) => part.state === "running");
  const editParts = toolParts.filter((part) => part.name === "edit" && Boolean(toolDiff(part)));
  const editTotals = editParts.reduce(
    (total, part) => {
      const stats = diffStats(toolDiff(part)!);
      return {
        additions: total.additions + stats.additions,
        deletions: total.deletions + stats.deletions,
      };
    },
    { additions: 0, deletions: 0 },
  );
  const label =
    editParts.length > 0
      ? `${editParts.length} ${editParts.length === 1 ? "edit" : "edits"} · +${editTotals.additions} −${editTotals.deletions}`
      : tools === 0
        ? "Reasoning"
        : `${tools} tool ${tools === 1 ? "call" : "calls"}`;
  const activityVersion = JSON.stringify(parts);
  useLayoutEffect(() => {
    if (!isStreaming || !open || !logRef.current || !logIsAtBottomRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [activityVersion, isStreaming, open]);
  if (tools === 0 && !reasoningHasContent)
    return (
      <div className="activity-group activity-group-status" role="status">
        <span
          className={`work-log-state${activityIsRunning ? " work-log-running" : ""}`}
          aria-label={activityIsRunning ? "working" : "complete"}
        />
        {reasoningIsStreaming ? "Thinking…" : "Reasoning details not exposed"}
      </div>
    );
  return (
    <details className="activity-group" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          behavior.store.setWorkLogsExpansion(
            behavior.store.workLogsExpansion === "collapsed" ? "expanded" : "collapsed",
          );
        }}
      >
        <span
          className={`work-log-state${activityIsRunning ? " work-log-running" : ""}`}
          aria-label={activityIsRunning ? "working" : "complete"}
        />
        Work log <small>{label}</small>
        <div className="work-log-view-toggle" role="group" aria-label="Work log view">
          <IconButton
            className="work-log-view-option"
            aria-pressed={behavior.workLogDiff}
            tooltip="Diff"
            ariaLabel="Show diff"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!behavior.workLogDiff) behavior.onToggleWorkLogDiff();
              if (behavior.store.workLogsExpansion === "collapsed")
                behavior.store.setWorkLogsExpansion("expanded");
            }}
          >
            <DiffIcon />
          </IconButton>
          <IconButton
            className="work-log-view-option"
            aria-pressed={!behavior.workLogDiff}
            tooltip="Work log"
            ariaLabel="Show work log"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (behavior.workLogDiff) behavior.onToggleWorkLogDiff();
              if (behavior.store.workLogsExpansion === "collapsed")
                behavior.store.setWorkLogsExpansion("expanded");
            }}
          >
            <LogIcon />
          </IconButton>
        </div>
      </summary>
      {open && (
        <div
          ref={logRef}
          onScroll={(event) => {
            const log = event.currentTarget;
            logIsAtBottomRef.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 1;
          }}
        >
          {behavior.workLogDiff ? (
            <WorkLogDiff
              parts={parts}
              streaming={activityIsRunning}
              onOpenFile={behavior.openFileInEditor}
            />
          ) : (
            parts.map((part) => (
              <TranscriptPart key={part.id} part={part} behavior={behavior} workLogItem />
            ))
          )}
        </div>
      )}
    </details>
  );
});

function ReviewRunMessage({
  run,
  onOpen,
}: {
  run: Extract<UiPart, { kind: "review-run" }>;
  onOpen?(threadId?: string): void;
}) {
  const count = run.commentCount;
  const label =
    run.status === "running"
      ? `Replying to ${count} ${count === 1 ? "comment" : "comments"}`
      : run.status === "error"
        ? `${count} ${count === 1 ? "comment needs" : "comments need"} another try`
        : `${count} ${count === 1 ? "comment" : "comments"} replied`;
  return (
    <Message className="review-run-message mr-auto w-full">
      <MessageLabel>{run.status === "running" ? "Cake · working" : "Cake"}</MessageLabel>
      <button
        type="button"
        className={run.status}
        disabled={!onOpen}
        onClick={() => onOpen?.(run.threadIds[0])}
      >
        {run.status === "running" && <LoadingState label={label} variant="Dots" />}
        {run.status !== "running" && <strong>{label}</strong>}
        <span>View in Changes</span>
      </button>
    </Message>
  );
}

const TranscriptList = forwardRef<HTMLDivElement, ComponentProps<"div">>(function TranscriptList(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`transcript-list ${className ?? ""}`}
      aria-label="Conversation"
      {...props}
    />
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

export const ChatTranscript = observer(function ChatTranscript({
  store,
  behavior = {},
  empty,
  footer,
  error: errorOverride,
  virtualized = true,
  renderChat,
}: {
  store: ChatStore;
  behavior?: ChatTranscriptBehavior;
  empty?: ReactNode;
  footer?: ReactNode;
  error?: { message: string; details?: string; title?: string };
  virtualized?: boolean;
  renderChat(store: ChatStore): ReactNode;
}) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const staticTranscriptRef = useRef<HTMLDivElement>(null);
  const [selectionMenu, setSelectionMenu] = useState<TranscriptSelectionCapture>();
  const [draftAnchor, setDraftAnchor] = useState<MessageCommentAnchorRect>();
  const visibleParts = store.hideThinking
    ? store.parts.filter((part) => part.kind !== "reasoning")
    : store.parts;
  const showAssistantLoading = chatWorkIsActive(
    store.parts,
    store.streaming,
    store.submitting,
    Boolean(behavior.waitingForUser || behavior.artifacts?.interaction.request),
  );
  const items: TranscriptItem[] = [
    ...groupTranscriptParts(visibleParts),
    ...(showAssistantLoading ? [{ kind: "loading-state" as const, id: "loading-state" }] : []),
  ];
  const latestUserPartId = store.parts.findLast(
    (part) =>
      (part.kind === "text" && part.role === "user") ||
      (part.kind === "attachment" && part.attachmentKind === "image"),
  )?.id;
  const itemCountRef = useRef(items.length);
  itemCountRef.current = items.length;
  const transcriptBehavior: CanonicalTranscriptBehavior = {
    store,
    ...behavior,
    workLogDiff: store.workLogDiff,
    onToggleWorkLogDiff: () => store.toggleWorkLogDiff(),
    renderChat,
  };
  const scrollToLatest = useCallback(() => {
    if (itemCountRef.current > 0)
      virtuosoRef.current?.scrollToIndex({
        index: itemCountRef.current - 1,
        align: "end",
        behavior: "auto",
      });
    if (staticTranscriptRef.current)
      staticTranscriptRef.current.scrollTop = staticTranscriptRef.current.scrollHeight;
  }, []);
  useLayoutEffect(scrollToLatest, [store.id, scrollToLatest]);
  useEffect(() => {
    if (!latestUserPartId) return;
    scrollToLatest();
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [latestUserPartId, scrollToLatest]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "o") {
        event.preventDefault();
        store.cycleWorkLogsExpansion();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);
  const error = errorOverride ?? store.error;
  // Right-clicking any selection inside this conversation offers "Chat about
  // this". The capture resolves the selection to a part owned by this store,
  // so sibling or nested transcripts never react to each other's selections.
  const messageComments = behavior.messageComments;
  useEffect(() => {
    if (!messageComments) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const targetElement = target instanceof Element ? target : target.parentElement;
      // Editing surfaces keep their native cut/copy/paste menu.
      if (
        targetElement?.closest(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
        )
      )
        return;
      const capture = captureTranscriptSelection(store.parts, {
        x: event.clientX,
        y: event.clientY,
      });
      if (!capture) return;
      event.preventDefault();
      setSelectionMenu(capture);
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [messageComments, store.parts]);
  const openSelectionDraft = (capture: TranscriptSelectionCapture) => {
    if (!messageComments) return;
    messageComments.prepareDraft(capture.selection);
    setDraftAnchor(capture.rect);
    setSelectionMenu(undefined);
  };
  const selectionOverlays = (
    <>
      {selectionMenu && (
        <ContextMenu
          position={{ x: selectionMenu.x, y: selectionMenu.y }}
          items={[
            {
              id: "chat-about-this",
              label: "Chat about this",
              onSelect: () => openSelectionDraft(selectionMenu),
            },
          ]}
          onClose={() => setSelectionMenu(undefined)}
        />
      )}
      {draftAnchor && messageComments && (
        <MessageCommentDraftPopover
          anchor={draftAnchor}
          chatStore={messageComments.draftChatStore}
          renderChat={renderChat}
          onClose={() => setDraftAnchor(undefined)}
        />
      )}
    </>
  );
  const renderItem = (item: TranscriptItem, index: number) => (
    <div
      key={item.id}
      className={`transcript-item${errorNoticeFollowsUser(items, index) ? " transcript-item-error-after-user" : ""}`}
    >
      {item.kind === "activity-group" ? (
        <ActivityGroup
          parts={item.parts}
          behavior={transcriptBehavior}
          isStreaming={store.streaming}
        />
      ) : item.kind === "loading-state" ? (
        <LoadingState startedAt={store.loadingStartedAt} />
      ) : item.kind === "review-run" ? (
        <ReviewRunMessage run={item} onOpen={transcriptBehavior.onOpenReviewRun} />
      ) : (
        <TranscriptPart part={item} behavior={transcriptBehavior} />
      )}
    </div>
  );
  if (visibleParts.length === 0)
    return (
      <>
        {selectionOverlays}
        <div className="transcript transcript-empty">
          <Conversation>
            {empty}
            {showAssistantLoading && <LoadingState startedAt={store.loadingStartedAt} />}
            {footer}
            {error?.message && (
              <ErrorNotice
                title={error.title ?? "Operation failed"}
                message={error.message}
                details={error.details}
              />
            )}
          </Conversation>
        </div>
      </>
    );
  if (!virtualized)
    return (
      <>
        {selectionOverlays}
        <div ref={staticTranscriptRef} className="transcript">
          <TranscriptList>
            {items.map(renderItem)}
            <div className="transcript-footer">
              {footer}
              {error?.message && (
                <ErrorNotice
                  title={error.title ?? "Operation failed"}
                  message={error.message}
                  details={error.details}
                />
              )}
            </div>
          </TranscriptList>
        </div>
      </>
    );
  return (
    <>
      {selectionOverlays}
      <VirtualizedConversation
        ref={virtuosoRef}
        className="transcript"
        data={items}
        computeItemKey={(_index, item) => item.id}
        initialTopMostItemIndex={{ index: items.length - 1, align: "end" }}
        followOutput={(isAtBottom) => (isAtBottom ? "auto" : false)}
        components={{
          List: TranscriptList,
          Footer: () => (
            <div className="transcript-footer">
              {footer}
              {error?.message && (
                <ErrorNotice
                  title={error.title ?? "Operation failed"}
                  message={error.message}
                  details={error.details}
                />
              )}
            </div>
          ),
        }}
        itemContent={(index, item) => renderItem(item, index)}
      />
    </>
  );
});
