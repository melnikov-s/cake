import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { observer } from "r-state-tree/react";
import { Markdown } from "@/components/ai-elements/markdown";
import { Message, MessageContent, MessageLabel } from "@/components/ai-elements/message";
import { FullscreenButton, FullscreenSurface } from "@/components/fullscreen-surface";
import { IconButton } from "@/components/ui/icon-button";
import { ChatIcon, CheckIcon, CopyIcon, ForkIcon, HandoffIcon } from "@/components/ui/icons";
import {
  MessageCommentThreadPopover,
  type MessageCommentAnchorRect,
} from "@/components/message-comment-popover";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type { SourceLocation } from "../../ipc/source-location";
import type { UiPart } from "../../ipc/session-contract";
import type { ArtifactInteractionStore } from "../stores/ArtifactInteractionStore";
import type { ChatStore } from "../stores/ChatStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { MessageCommentsStore, MessageSelectionAnchor } from "../stores/MessageCommentsStore";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";

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
      part.kind === "skill" ||
      part.kind === "annotation" ||
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
    onOpenSourceLocation?(location: SourceLocation): void;
  }
>(function ChatTextMessage({ part, contentRef, children, onOpenSourceLocation }, ref) {
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
        className={assistant ? "assistant-message-content" : "user-message whitespace-pre-wrap"}
      >
        {assistant ? (
          <Markdown
            highlightCode={part.status !== "streaming"}
            onOpenSourceLocation={onOpenSourceLocation}
          >
            {part.text}
          </Markdown>
        ) : (
          part.text
        )}
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
}

/** Resolves the active browser selection against the parts this transcript
 *  owns, so every selectable surface (user messages, assistant replies, code,
 *  work logs, artifacts) can be right-clicked into a selection chat. */
export function captureTranscriptSelection(
  parts: UiPart[],
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
  return { selection, rect: plainRect(selectionEndRect(range)) };
}

export interface ChatTranscriptBehavior {
  onFork?(entryId: string): void;
  onHandoff?(entryId: string): void;
  onOpenReviewRun?(threadId?: string): void;
  /** Opens a structured workspace source location in Cake's embedded VS Code IDE. */
  openSourceLocation?(location: SourceLocation): void;
  waitingForUser?: boolean;
  inlineWidgets?: InlineWidgetStore;
  artifacts?: { records: ArtifactRecord[]; interaction: ArtifactInteractionStore };
  messageComments?: MessageCommentsStore;
  subagents?: SubagentActivityStore;
  showSelectionContextMenu?(input: {
    canChat: boolean;
    canAnnotate: boolean;
  }): Promise<"chat-about-selection" | "add-annotation" | undefined>;
}

export interface CanonicalTranscriptBehavior extends ChatTranscriptBehavior {
  store: ChatStore;
  renderChat(store: ChatStore): ReactNode;
}

export const AssistantTextMessage = observer(function AssistantTextMessage({
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

  const content = () => (
    <Markdown
      highlightCode={part.status !== "streaming"}
      onOpenSourceLocation={behavior.openSourceLocation}
    >
      {part.text}
    </Markdown>
  );

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
      onOpenSourceLocation={behavior.openSourceLocation}
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
              <ChatIcon size={15} />
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
              tooltip="Fork with full context"
              ariaLabel="Fork response with full context into new chat"
              onClick={() => behavior.onFork!(part.entryId!)}
            >
              <ForkIcon />
            </IconButton>
          )}
          {part.entryId && behavior.onHandoff && (
            <IconButton
              tooltip="Hand off without tool history"
              ariaLabel="Hand off response without tool history into new chat"
              onClick={() => behavior.onHandoff!(part.entryId!)}
            >
              <HandoffIcon />
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
