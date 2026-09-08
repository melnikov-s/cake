import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useStickToBottom, type StickToBottomInstance } from "use-stick-to-bottom";
import { untracked } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { AnnotationDraftPopover } from "@/components/annotation-draft-popover";
import { ChatTranscriptFooter } from "./chat-transcript-footer";
import { ChangedFiles } from "@/components/changed-files";
import { LoadingState } from "@/components/ui/loading-state";
import {
  MessageCommentDraftPopover,
  type MessageCommentAnchorRect,
} from "@/components/message-comment-popover";
import { workLogChanges } from "../../utils/turn-diff";
import type { ChatStore, TranscriptScrollPosition } from "../stores/ChatStore";
import {
  ActivityGroup,
  ErrorNotice,
  ReviewRunMessage,
  TranscriptList,
  TranscriptPart,
  captureTranscriptSelection,
  chatWorkIsActive,
  errorNoticeFollowsUser,
  groupTranscriptParts,
  type CanonicalTranscriptBehavior,
  type ChatTranscriptBehavior,
  type TranscriptItem,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

export {
  captureMessageSelection,
  chatWorkIsActive,
  groupTranscriptParts,
  type ChatTranscriptBehavior,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

export type ChatTranscriptHandle = Pick<StickToBottomInstance, "scrollToBottom">;

const defaultTranscriptBehavior: ChatTranscriptBehavior = {};

export const ChatTranscript = observer(function ChatTranscript({
  store,
  behavior = defaultTranscriptBehavior,
  empty,
  footer,
  error: errorOverride,
  virtualized = true,
  ref,
  renderChat,
}: {
  store: ChatStore;
  behavior?: ChatTranscriptBehavior;
  empty?: ReactNode;
  footer?: ReactNode;
  error?: { message: string; details?: string; title?: string };
  virtualized?: boolean;
  ref?: Ref<ChatTranscriptHandle>;
  renderChat(store: ChatStore): ReactNode;
}) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const pendingSelectionRef = useRef<TranscriptSelectionCapture | undefined>(undefined);
  const restoredScrollPosition = useMemo(
    () => untracked(() => store.transcriptScrollPosition),
    [store],
  );
  const [draftAnchor, setDraftAnchor] = useState<MessageCommentAnchorRect>();
  const [annotationDraft, setAnnotationDraft] = useState<TranscriptSelectionCapture>();
  const { scrollRef, contentRef, scrollToBottom, stopScroll } = useStickToBottom({
    initial: restoredScrollPosition || store.messageNavigationRequest ? false : "instant",
    resize: "instant",
  });
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);
  const attachScroller = useCallback(
    (element: HTMLDivElement | null) => {
      scrollRef(element);
      setScroller(element);
    },
    [scrollRef],
  );
  const parts = store.parts;
  const visibleParts = store.hideThinking
    ? parts.filter((part) => part.kind !== "reasoning")
    : parts;
  const showAssistantLoading = chatWorkIsActive(
    parts,
    store.streaming,
    store.submitting,
    Boolean(behavior.waitingForUser || behavior.artifacts?.interaction.request),
  );
  useLayoutEffect(() => {
    store.syncChangedFilesOpen(showAssistantLoading);
  }, [showAssistantLoading, store]);
  const groupedParts = groupTranscriptParts(parts);
  const hasWorkLogChanges = useMemo(() => workLogChanges(parts).length > 0, [parts]);
  const visibleGroupedParts = store.hideThinking
    ? groupedParts.flatMap((item): TranscriptItem[] => {
        if (item.kind === "reasoning") return [];
        if (item.kind !== "activity-group") return [item];
        const visibleGroupParts = item.parts.filter((part) => part.kind !== "reasoning");
        return visibleGroupParts.length > 0 ? [{ ...item, parts: visibleGroupParts }] : [];
      })
    : groupedParts;
  const items: TranscriptItem[] = [
    ...visibleGroupedParts,
    ...(hasWorkLogChanges ? [{ kind: "changed-files" as const, id: "changed-files" }] : []),
    ...(showAssistantLoading ? [{ kind: "loading-state" as const, id: "loading-state" }] : []),
  ];
  const transcriptBehavior = useMemo<CanonicalTranscriptBehavior>(
    () => ({ store, ...behavior, renderChat }),
    [behavior, renderChat, store],
  );
  const messageNavigationRequest = store.messageNavigationRequest;
  const messageNavigationItemIndex = messageNavigationRequest
    ? items.findIndex((item) =>
        item.kind === "activity-group" || item.kind === "source-group"
          ? item.parts.some((part) => part.id === messageNavigationRequest.messageId)
          : item.id === messageNavigationRequest.messageId,
      )
    : -1;
  const restoredMessageItemIndex =
    restoredScrollPosition?.kind === "message"
      ? items.findIndex((item) =>
          item.kind === "activity-group" || item.kind === "source-group"
            ? item.parts.some((part) => part.id === restoredScrollPosition.messageId)
            : item.id === restoredScrollPosition.messageId,
        )
      : -1;
  const restoredItemLocation =
    restoredScrollPosition?.kind === "top"
      ? { index: 0, align: "start" as const }
      : restoredScrollPosition?.kind === "bottom"
        ? { index: items.length - 1, align: "end" as const }
        : restoredScrollPosition?.kind === "message" && restoredMessageItemIndex >= 0
          ? {
              index: restoredMessageItemIndex,
              align: "start" as const,
              offset: -restoredScrollPosition.offset,
            }
          : undefined;
  const openingItemLocation =
    messageNavigationItemIndex >= 0
      ? undefined
      : (restoredItemLocation ?? { index: items.length - 1, align: "end" as const });
  useLayoutEffect(() => {
    if (!messageNavigationRequest || messageNavigationItemIndex < 0) return;
    stopScroll();
    if (virtualized)
      virtuosoRef.current?.scrollToIndex({
        index: messageNavigationItemIndex,
        align: "center",
        behavior: "auto",
      });
    else
      scroller
        ?.querySelector<HTMLElement>(`[data-transcript-item-index="${messageNavigationItemIndex}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [messageNavigationItemIndex, messageNavigationRequest, scroller, stopScroll, virtualized]);
  useEffect(() => {
    if (!scroller) return;
    let pendingPosition = untracked(() => store.transcriptScrollPosition);
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const captureScrollPosition = (): TranscriptScrollPosition | undefined => {
      if (scroller.clientHeight <= 0) return undefined;
      if (scroller.scrollTop <= 1) return { kind: "top" };
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1)
        return { kind: "bottom" };
      const viewportTop = scroller.getBoundingClientRect().top;
      const anchor = Array.from(
        scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]"),
      ).find((item) => item.getBoundingClientRect().bottom > viewportTop + 1);
      const messageId = anchor?.dataset.transcriptAnchorId;
      if (!anchor || !messageId) return undefined;
      return {
        kind: "message",
        messageId,
        offset: anchor.getBoundingClientRect().top - viewportTop,
      };
    };
    const commitScrollPosition = () => {
      saveTimer = undefined;
      if (pendingPosition) store.setTranscriptScrollPosition(pendingPosition);
    };
    const captureAndSchedule = () => {
      pendingPosition = captureScrollPosition();
      if (!pendingPosition) return;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(commitScrollPosition, 100);
    };
    scroller.addEventListener("scroll", captureAndSchedule, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", captureAndSchedule);
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      pendingPosition = captureScrollPosition() ?? pendingPosition;
      if (pendingPosition) store.setTranscriptScrollPosition(pendingPosition);
    };
  }, [scroller, store]);
  const error = errorOverride ?? store.error;
  // Right-clicking any selection inside this conversation keeps the native
  // Electron edit menu. The capture is held until that menu sends its
  // "Chat about this" action back to this transcript.
  const messageComments = behavior.messageComments;
  const openSelectionDraft = useCallback(
    (capture: TranscriptSelectionCapture) => {
      if (!messageComments) return;
      messageComments.prepareDraft(capture.selection);
      pendingSelectionRef.current = undefined;
      setDraftAnchor(capture.rect);
    },
    [messageComments],
  );
  useEffect(() => {
    const showContextMenu = behavior.showSelectionContextMenu;
    if ((!messageComments && !store.canAnnotate) || !showContextMenu) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      pendingSelectionRef.current = undefined;
      if (!(target instanceof Node)) return;
      const targetElement = target instanceof Element ? target : target.parentElement;
      // Editing surfaces retain the ordinary native edit menu and cannot start
      // a transcript-selection workflow.
      if (
        targetElement?.closest(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
        )
      )
        return;
      const capture = captureTranscriptSelection(store.parts);
      if (!capture) return;
      event.preventDefault();
      pendingSelectionRef.current = capture;
      void showContextMenu({
        canChat: Boolean(messageComments),
        canAnnotate: Boolean(store.canAnnotate),
      })
        .then((action) => {
          if (pendingSelectionRef.current !== capture) return;
          pendingSelectionRef.current = undefined;
          if (action === "chat-about-selection") openSelectionDraft(capture);
          else if (action === "add-annotation") setAnnotationDraft(capture);
        })
        .catch(() => {
          if (pendingSelectionRef.current === capture) pendingSelectionRef.current = undefined;
        });
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [behavior.showSelectionContextMenu, messageComments, openSelectionDraft, store]);
  const changedFiles = (
    <ChangedFiles
      parts={parts}
      workspacePath={behavior.workspacePath}
      open={store.changedFilesOpen}
      onOpenChange={(open) => store.setChangedFilesOpen(open)}
      onOpenFile={
        behavior.openSourceLocation
          ? (path) => behavior.openSourceLocation?.({ path, view: "changes" })
          : undefined
      }
    />
  );
  const selectionOverlays = (
    <>
      {draftAnchor && messageComments && (
        <MessageCommentDraftPopover
          anchor={draftAnchor}
          chatStore={messageComments.draftChatStore}
          renderChat={renderChat}
          onClose={() => setDraftAnchor(undefined)}
        />
      )}
      {annotationDraft && (
        <AnnotationDraftPopover
          anchor={annotationDraft.rect}
          selection={annotationDraft.selection}
          onAdd={(annotation) => store.addAnnotation(annotation)}
          onClose={() => setAnnotationDraft(undefined)}
        />
      )}
    </>
  );
  const renderItem = (item: TranscriptItem, index: number) => (
    <div
      key={item.id}
      data-slot="transcript-item"
      data-transcript-item-index={index}
      data-transcript-anchor-id={
        item.kind === "activity-group" || item.kind === "source-group" ? item.parts[0]?.id : item.id
      }
      className={cn(
        "min-w-0 pb-5 in-[.chat-layout-compact]:pb-3.5",
        errorNoticeFollowsUser(items, index) && "pt-3",
      )}
    >
      {item.kind === "activity-group" ? (
        <ActivityGroup groupId={item.id} parts={item.parts} behavior={transcriptBehavior} />
      ) : item.kind === "source-group" ? (
        <div className="flex flex-wrap items-center gap-2" data-slot="source-group">
          {item.parts.map((part) => (
            <TranscriptPart key={part.id} part={part} behavior={transcriptBehavior} />
          ))}
        </div>
      ) : item.kind === "changed-files" ? (
        changedFiles
      ) : item.kind === "loading-state" ? (
        <LoadingState startedAt={store.loadingStartedAt} />
      ) : item.kind === "review-run" ? (
        <ReviewRunMessage run={item} onOpen={transcriptBehavior.onOpenReviewRun} />
      ) : (
        <TranscriptPart part={item} behavior={transcriptBehavior} />
      )}
    </div>
  );
  return (
    <>
      {selectionOverlays}
      <div
        ref={attachScroller}
        className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges] [overflow-anchor:none]"
      >
        <div ref={contentRef} className="min-w-0">
          {visibleParts.length === 0 ? (
            <Conversation className="px-6 pt-[42px] pb-[210px] max-[620px]:px-4">
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
          ) : !virtualized ? (
            <TranscriptList>
              {items.map(renderItem)}
              <ChatTranscriptFooter context={{ footer, error }} />
            </TranscriptList>
          ) : (
            scroller && (
              <VirtualizedConversation
                ref={virtuosoRef}
                customScrollParent={scroller}
                data={items}
                context={{ footer, error }}
                computeItemKey={(_index, item) => item.id}
                initialTopMostItemIndex={openingItemLocation}
                followOutput={false}
                components={{ List: TranscriptList, Footer: ChatTranscriptFooter }}
                itemContent={(index, item) => renderItem(item, index)}
              />
            )
          )}
        </div>
      </div>
    </>
  );
});
