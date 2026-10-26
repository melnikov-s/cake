import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { observer } from "r-state-tree/react";
import { isStandaloneDiagram, Markdown } from "@/components/ai-elements/markdown";
import { cakeHotkeyEventName } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { rangeAtOffsets, useMessageHighlights } from "@/lib/message-highlights";
import { Message, MessageContent, MessageLabel } from "@/components/ai-elements/message";
import { FullscreenMessage } from "@/components/fullscreen-message";
import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { SessionMessage } from "@/components/session-message";
import { IconButton } from "@/components/ui/icon-button";
import {
  ChatIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ForkIcon,
  TreeIcon,
} from "@/components/ui/icons";
import { AnnotationItemPopover } from "./annotation-item-popover";
import type { ArtifactRecord } from "../../contracts/artifacts/artifact-contract";
import type { SourceLocation } from "../../contracts/editor/source-location";
import type { UiPart } from "../../contracts/conversations/session-contract";
import type { ChatStore } from "../stores/ChatStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { InterviewStore } from "../stores/InterviewStore";
import type { InlineArtifactPreviewStore } from "../stores/InlineArtifactPreviewStore";
import type { MessageCommentsStore, MessageSelectionAnchor } from "../stores/MessageCommentsStore";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import type { SideChatTarget } from "../stores/SideChatStore";
import type { MessageCommentAnchorRect } from "./message-comment-anchor";
import { describeScheduledOrigin } from "../../utils/scheduled-message-time";
import { SubagentReportAssignment } from "./subagent-report-assignment";
import {
  subagentReportBadge,
  subagentReportFindings,
  subagentReportHeading,
} from "../lib/subagent-report-presentation";
import { crossSessionPresentation } from "../lib/cross-session-presentation";
import type { MessageReferencePreviewStore } from "../stores/MessageReferencePreviewStore";
import type { ResultTodoLink } from "./result-todo-done";
import { resultTodoOrigin } from "../lib/result-todo-origin";

export function chatWorkIsActive(
  parts: UiPart[],
  streaming: boolean,
  submitting: boolean,
  waitingForUser = false,
) {
  if (waitingForUser) return false;
  if (streaming) return true;
  if (!submitting) return false;
  // Direct !/!! commands stream their own result surface and never start a
  // model turn, so do not add the generic assistant loading indicator.
  if (parts.at(-1)?.kind === "command") return false;
  // Injected context pills follow the input but are not evidence of assistant work.
  const dialogueAndActivity = parts.filter((part) => part.kind !== "context");
  const latestUserIndex = dialogueAndActivity.findLastIndex(
    (part) =>
      (part.kind === "text" && part.role === "user") ||
      part.kind === "skill" ||
      part.kind === "annotation" ||
      (part.kind === "attachment" && part.attachmentKind === "image"),
  );
  return latestUserIndex < 0 || latestUserIndex === dialogueAndActivity.length - 1;
}

export const ChatTextMessage = forwardRef<
  HTMLElement,
  {
    part: Extract<UiPart, { kind: "text" }>;
    contentRef?: RefObject<HTMLDivElement | null>;
    children?: ReactNode;
    onMouseEnter?: MouseEventHandler<HTMLElement>;
    onMouseLeave?: MouseEventHandler<HTMLElement>;
    onOpenSourceLocation?(location: SourceLocation): void;
    omitArtifactEmbeds?: readonly string[];
    /** Exact originals that carry the content of an incoming receipt. */
    sources?: readonly MessageReferencePreviewStore[];
    reportSource?: { href?: string };
    /** To-dos tracking an incoming message, with Done checkboxes on its card. */
    todo?: ResultTodoLink;
  }
>(function ChatTextMessage(
  {
    part,
    contentRef,
    children,
    onMouseEnter,
    onMouseLeave,
    onOpenSourceLocation,
    omitArtifactEmbeds,
    sources = [],
    reportSource,
    todo,
  },
  ref,
) {
  const report = part.subagentReport;
  const crossSession = useMemo(
    () => (part.crossSession ? crossSessionPresentation(part.text, part.crossSession) : undefined),
    [part.text, part.crossSession],
  );
  const text = report
    ? subagentReportFindings(part.text, report)
    : (crossSession?.body ?? part.text);
  const assistant = part.role === "assistant";
  const scheduled = part.scheduled ? describeScheduledOrigin(part.scheduled) : undefined;
  const userLabel = scheduled
    ? `You · ${scheduled.summary}`
    : part.deliveryState === "sending"
      ? "You · sending"
      : part.draft
        ? "You · draft"
        : "You";
  const content = text ? (
    <MessageContent
      ref={contentRef}
      className={cn(
        report || part.crossSession
          ? "rounded-none border-0 bg-transparent p-0 shadow-none"
          : assistant
            ? "bg-card text-foreground"
            : "border-user-message-foreground/20 bg-user-message text-user-message-foreground dark:border-border",
        !assistant &&
          !report &&
          !part.crossSession &&
          part.renderAs !== "markdown" &&
          "whitespace-pre-wrap",
      )}
    >
      {assistant || report || part.crossSession || part.renderAs === "markdown" ? (
        <Markdown
          streaming={part.status === "streaming"}
          normalizeLatexDelimiters={part.status !== "streaming"}
          onOpenSourceLocation={onOpenSourceLocation}
          omitArtifactEmbeds={omitArtifactEmbeds}
          className="has-[[data-slot=artifact-disclosure]]:[&>:not([data-slot=artifact-disclosure])]:mx-auto has-[[data-slot=artifact-disclosure]]:[&>:not([data-slot=artifact-disclosure])]:max-w-[45.375rem]"
        >
          {text}
        </Markdown>
      ) : (
        text
      )}
    </MessageContent>
  ) : null;
  return (
    <Message
      ref={ref}
      data-slot={report ? "subagent-report" : "message"}
      aria-label={report ? subagentReportHeading(report) : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        assistant || report || part.crossSession
          ? "group/msg relative mr-auto w-full"
          : "group/msg relative ml-auto w-[min(88%,42rem)]",
      )}
    >
      {!assistant &&
        !report &&
        !part.crossSession &&
        (scheduled ? (
          <MessageLabel className="flex items-center gap-1" title={scheduled.detail}>
            <ClockIcon />
            <span>{userLabel}</span>
          </MessageLabel>
        ) : (
          <MessageLabel>{userLabel}</MessageLabel>
        ))}
      {part.crossSession || report ? (
        <SessionMessage
          source={part.crossSession?.sender ?? reportSource}
          title={report ? `Worker ${report.handleId.slice(0, 8)}` : undefined}
          relation={crossSession?.relation}
          badges={report ? [subagentReportBadge(report)] : crossSession?.badges}
          preview={text}
          sources={content ? undefined : sources}
          originals={content ? sources : undefined}
          todo={todo}
        >
          {report && <SubagentReportAssignment key={part.id} report={report} />}
          {content}
          {crossSession?.sourceResponse && !sources.length && (
            <p className="text-sm text-muted-foreground">
              Original response unavailable: no exact source reference was recorded.
            </p>
          )}
        </SessionMessage>
      ) : (
        content
      )}
      {children}
    </Message>
  );
});

const ASSISTANT_FULLSCREEN_MIN_CHARACTERS = 500;

function textOffset(container: Node, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().length;
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
    partElement.querySelector<HTMLElement>('[data-slot="message-content"]') ?? partElement;
  const selection = captureMessageSelection(
    container,
    partId,
    part.kind === "text" ? part.entryId : undefined,
  );
  if (!selection) return undefined;
  return { selection, rect: plainRect(selectionEndRect(range)) };
}

export interface ChatTranscriptBehavior {
  /** Addressable session identity used for exact attachment-reference links. */
  messageReferenceSessionId?: string;
  /** Project root used to present workspace files without machine-specific prefixes. */
  workspacePath?: string;
  onFork?(entryId: string): void;
  onTree?(entryId: string): void;
  onOpenReviewRun?(threadId?: string): void;
  /** Opens a structured workspace source location in Cake's embedded VS Code IDE. */
  openSourceLocation?(location: SourceLocation): void;
  waitingForUser?: boolean;
  inlineWidgets?: InlineWidgetStore;
  inlineArtifactPreviews?: InlineArtifactPreviewStore;
  artifacts?: {
    records: ArtifactRecord[];
  };
  interviews?: readonly InterviewStore[];
  messageComments?: MessageCommentsStore;
  subagents?: SubagentActivityStore;
  /** The chat's to-do list; result messages offer a one-click Done for linked open to-dos. */
  todos?: ProjectTodosStore;
  /** Hides the response fullscreen affordance for compact, transient chats. */
  showAssistantFullscreen?: boolean;
  showSelectionContextMenu?(input: {
    canChat: boolean;
    canAnnotate: boolean;
  }): Promise<"chat-about-selection" | "add-annotation" | undefined>;
}

export interface CanonicalTranscriptBehavior extends ChatTranscriptBehavior {
  store: ChatStore;
  openSideChat?(target: SideChatTarget): void;
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
  const [openAnnotation, setOpenAnnotation] = useState<{
    id: string;
    anchor: HTMLElement | MessageCommentAnchorRect;
  }>();
  const [markerPositions, setMarkerPositions] = useState<
    Record<string, { left: number; top: number }>
  >({});
  const messageRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const commentThreads = behavior.messageComments?.threadsForMessage(part.id) ?? [];
  const draftAnnotations = behavior.store.annotations.filter(
    (annotation) => annotation.messageId === part.id,
  );
  const presentation = part.crossSession
    ? crossSessionPresentation(part.text, part.crossSession)
    : undefined;
  const copyText = presentation?.body ?? part.text;
  const sources = part.crossSession
    ? behavior.store.messageSources.filter((source) => source.props.partId === part.id)
    : [];
  const canOpenFullscreen =
    !part.crossSession &&
    part.text.length >= ASSISTANT_FULLSCREEN_MIN_CHARACTERS &&
    !isStandaloneDiagram(part.text);
  const openFullscreen = useCallback(() => {
    if (canOpenFullscreen) setFullscreen(true);
  }, [canOpenFullscreen]);
  const closeFullscreen = useCallback(() => setFullscreen(false), []);
  useEffect(() => {
    const onHotkey = () => {
      if (messageRef.current?.matches(":hover")) openFullscreen();
    };
    window.addEventListener(cakeHotkeyEventName, onHotkey);
    return () => window.removeEventListener(cakeHotkeyEventName, onHotkey);
  }, [openFullscreen]);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const highlightAnchors = [...commentThreads.map((thread) => thread.anchor), ...draftAnnotations];
  useMessageHighlights(contentRef, highlightAnchors, part.text);

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
      for (const annotation of draftAnnotations) {
        const start = annotation.startOffset;
        const end = annotation.endOffset;
        if (start === undefined || end === undefined) continue;
        const range = rangeAtOffsets(contentNode, start, end);
        const rangeRects = range ? Array.from(range.getClientRects()) : [];
        const rect = rangeRects.at(-1) ?? range?.getBoundingClientRect();
        if (!rect) continue;
        next[annotation.id] = {
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
    draftAnnotations.map((a) => `${a.id}:${a.startOffset}:${a.endOffset}`).join("|"),
  ]);

  // Publication owns the inline surface. A follow-up Markdown embed must not
  // mount a second iframe for the same exact revision; prose links are unaffected.
  const publishedArtifactReferences = behavior.inlineArtifactPreviews
    ? behavior.store.parts.flatMap((candidate) =>
        candidate.kind === "tool" && candidate.artifactId
          ? [`cake://artifact/${candidate.artifactId}`]
          : [],
      )
    : undefined;
  const activeAnnotation = openAnnotation
    ? draftAnnotations.find((annotation) => annotation.id === openAnnotation.id)
    : undefined;

  return (
    <ChatTextMessage
      ref={messageRef}
      part={part}
      contentRef={contentRef}
      onOpenSourceLocation={behavior.openSourceLocation}
      omitArtifactEmbeds={publishedArtifactReferences}
      todo={{
        origin: resultTodoOrigin(part, behavior.messageReferenceSessionId ?? behavior.store.id),
        todos: behavior.todos,
      }}
      sources={sources}
    >
      {behavior.showAssistantFullscreen !== false && canOpenFullscreen && (
        <FullscreenButton
          className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md bg-transparent p-0 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/msg:opacity-100 group-focus-within/msg:opacity-100"
          label="View response fullscreen"
          onClick={openFullscreen}
        />
      )}
      {commentThreads.map(
        (thread, index) =>
          markerPositions[thread.id] && (
            <IconButton
              key={thread.id}
              className="absolute z-2 grid size-[27px] -translate-y-1/2 place-items-center rounded-full border border-accent/60 bg-card/90 text-foreground shadow-md hover:scale-105 hover:bg-accent/20 cursor-pointer"
              style={markerPositions[thread.id]}
              tooltip={thread.anchor.selectedText}
              ariaLabel={`Open selection chat ${index + 1}`}
              onClick={() => {
                const chatStore = behavior.messageComments?.chatStore(thread.id);
                if (!chatStore) return;
                behavior.openSideChat?.({
                  key: `selection-thread:${thread.id}`,
                  title: "Side chat",
                  eyebrow: () => "Selection",
                  chatStore,
                });
              }}
            >
              <ChatIcon size={15} />
              <b className="absolute -top-1.5 -right-1.5 grid min-w-6 min-h-6 px-1 place-items-center rounded-full border-2 border-background bg-accent text-accent-foreground font-mono font-bold text-xs">
                {thread.messageCount}
              </b>
            </IconButton>
          ),
      )}
      {draftAnnotations.map(
        (annotation, index) =>
          markerPositions[annotation.id] && (
            <IconButton
              key={annotation.id}
              className="absolute z-2 grid size-[27px] -translate-y-1/2 place-items-center rounded-full border border-accent/60 bg-card/90 text-foreground shadow-md hover:scale-105 hover:bg-accent/20 cursor-pointer"
              style={markerPositions[annotation.id]}
              tooltip={annotation.comment || annotation.selectedText}
              ariaLabel={`View annotation ${index + 1}`}
              onClick={(event) =>
                setOpenAnnotation({ id: annotation.id, anchor: event.currentTarget })
              }
            >
              <ChatIcon size={15} />
            </IconButton>
          ),
      )}
      {activeAnnotation && (
        <AnnotationItemPopover
          anchor={openAnnotation!.anchor}
          annotation={activeAnnotation}
          onUpdate={(id, update) => behavior.store.updateAnnotation(id, update)}
          onRemove={(id) => behavior.store.removeAnnotation(id)}
          onClose={() => setOpenAnnotation(undefined)}
        />
      )}
      {part.status !== "streaming" && !presentation?.sourceResponse && (
        <div
          data-slot="message-actions"
          className="mt-1.5 flex min-h-7 items-center gap-1 opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 transition-opacity"
          aria-label="Message actions"
        >
          <IconButton
            tooltip={copied ? "Copied" : "Copy response"}
            ariaLabel={copied ? "Copied response" : "Copy response"}
            onClick={() => void navigator.clipboard.writeText(copyText).then(() => setCopied(true))}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
          {!part.crossSession && part.entryId && behavior.onFork && (
            <IconButton
              tooltip="Fork with full context"
              ariaLabel="Fork response with full context into new chat"
              onClick={() => behavior.onFork!(part.entryId!)}
            >
              <ForkIcon />
            </IconButton>
          )}
          {!part.crossSession && part.entryId && behavior.onTree && (
            <IconButton
              tooltip="Continue here in session tree"
              ariaLabel="Continue from response in session tree"
              onClick={() => behavior.onTree!(part.entryId!)}
            >
              <TreeIcon />
            </IconButton>
          )}
        </div>
      )}
      {fullscreen && (
        <FullscreenMessage
          eyebrow="Full response"
          title="Cake"
          text={part.text}
          markdown
          streaming={part.status === "streaming"}
          partId={part.id}
          highlightAnchors={highlightAnchors}
          onOpenSourceLocation={behavior.openSourceLocation}
          onClose={closeFullscreen}
        />
      )}
    </ChatTextMessage>
  );
});

// Observer-wrapped: reads ChatStore.workLogItemOpen (per-item overrides plus the
// global expansion mode), so item clicks must re-render this component even when
// the rest of the transcript is idle.
