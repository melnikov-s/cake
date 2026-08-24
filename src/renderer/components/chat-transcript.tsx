import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { LoadingState } from "@/components/ui/loading-state";
import {
  MessageCommentDraftPopover,
  type MessageCommentAnchorRect,
} from "@/components/message-comment-popover";
import type { ChatStore } from "../stores/ChatStore";
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
  ChatTextMessage,
  captureMessageSelection,
  captureTranscriptSelection,
  chatWorkIsActive,
  type ChatTranscriptBehavior,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

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
  const virtualScrollerRef = useRef<HTMLElement | null>(null);
  const staticTranscriptRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<TranscriptSelectionCapture | undefined>(undefined);
  const followTurnRef = useRef<string | undefined>(undefined);
  const followOutputRef = useRef(true);
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
  const latestUserPartIndex = visibleParts.findLastIndex(
    (part) =>
      (part.kind === "text" && part.role === "user") ||
      part.kind === "skill" ||
      (part.kind === "attachment" && part.attachmentKind === "image"),
  );
  const latestUserPartId = visibleParts[latestUserPartIndex]?.id;
  const firstResponsePartId =
    latestUserPartIndex >= 0 ? visibleParts[latestUserPartIndex + 1]?.id : undefined;
  const responseStartItemId = items.find((item) =>
    item.kind === "activity-group"
      ? item.parts.some((part) => part.id === firstResponsePartId)
      : item.id === firstResponsePartId,
  )?.id;
  const followKey = `${store.id}:${latestUserPartId ?? ""}`;
  if (followTurnRef.current !== followKey) {
    followTurnRef.current = followKey;
    followOutputRef.current = true;
  }
  const itemCountRef = useRef(items.length);
  itemCountRef.current = items.length;
  const transcriptBehavior: CanonicalTranscriptBehavior = {
    store,
    ...behavior,
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
  const setVirtualScroller = useCallback((scroller: HTMLElement | null | Window) => {
    virtualScrollerRef.current = scroller instanceof HTMLElement ? scroller : null;
  }, []);
  useEffect(() => {
    const scroller = virtualScrollerRef.current;
    if (!scroller) return;
    const stopFollowing = () => {
      followOutputRef.current = false;
    };
    const stopFollowingForScrollbar = (event: PointerEvent) => {
      if (event.clientX >= scroller.getBoundingClientRect().right - 16) stopFollowing();
    };
    scroller.addEventListener("wheel", stopFollowing, { passive: true });
    scroller.addEventListener("touchmove", stopFollowing, { passive: true });
    scroller.addEventListener("pointerdown", stopFollowingForScrollbar);
    return () => {
      scroller.removeEventListener("wheel", stopFollowing);
      scroller.removeEventListener("touchmove", stopFollowing);
      scroller.removeEventListener("pointerdown", stopFollowingForScrollbar);
    };
  });
  const followStreamingOutput = useCallback((isAtBottom: boolean) => {
    if (!isAtBottom || !followOutputRef.current) return false;
    const scroller = virtualScrollerRef.current;
    const responseStart = scroller?.querySelector<HTMLElement>("[data-response-start]");
    if (
      scroller &&
      responseStart &&
      responseStart.getBoundingClientRect().top <= scroller.getBoundingClientRect().top + 1
    ) {
      followOutputRef.current = false;
      return false;
    }
    return "auto" as const;
  }, []);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (event.shiftKey) {
          store.cycleWorkLogViewMode();
        } else {
          store.cycleWorkLogsExpansion();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);
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
    if (!messageComments) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      pendingSelectionRef.current = undefined;
      if (!(target instanceof Node)) return;
      const targetElement = target instanceof Element ? target : target.parentElement;
      // Editing surfaces are handled by the same native menu, but their text
      // is not a message selection and therefore cannot start a selection chat.
      if (
        targetElement?.closest(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
        )
      )
        return;
      const capture = captureTranscriptSelection(store.parts);
      if (capture) pendingSelectionRef.current = capture;
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [messageComments, store.parts]);
  useEffect(() => {
    const subscribe = behavior.subscribeToChatAboutSelection;
    if (!messageComments || !subscribe) return;
    return subscribe(() => {
      const capture = pendingSelectionRef.current;
      if (capture) openSelectionDraft(capture);
    });
  }, [behavior.subscribeToChatAboutSelection, messageComments, openSelectionDraft]);
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
    </>
  );
  const renderItem = (item: TranscriptItem, index: number) => (
    <div
      key={item.id}
      data-response-start={item.id === responseStartItemId ? "" : undefined}
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
        className="transcript [overflow-anchor:none]"
        data={items}
        computeItemKey={(_index, item) => item.id}
        initialTopMostItemIndex={{ index: items.length - 1, align: "end" }}
        followOutput={followStreamingOutput}
        scrollerRef={setVirtualScroller}
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
