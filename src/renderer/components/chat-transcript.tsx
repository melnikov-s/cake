import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { AnnotationDraftPopover } from "@/components/annotation-draft-popover";
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
  captureMessageSelection,
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
  const latestUserRef = useRef<{ storeId: string; partId?: string } | undefined>(undefined);
  const restoredScrollState = useMemo(() => store.transcriptScrollState, [store]);
  const [draftAnchor, setDraftAnchor] = useState<MessageCommentAnchorRect>();
  const [annotationDraft, setAnnotationDraft] = useState<TranscriptSelectionCapture>();
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
      part.kind === "annotation" ||
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
  const messageNavigationRequest = store.messageNavigationRequest;
  const messageNavigationItemIndex = messageNavigationRequest
    ? items.findIndex((item) =>
        item.kind === "activity-group"
          ? item.parts.some((part) => part.id === messageNavigationRequest.messageId)
          : item.id === messageNavigationRequest.messageId,
      )
    : -1;
  const hasOpeningScrollTarget =
    restoredScrollState !== undefined || messageNavigationItemIndex >= 0;
  useEffect(() => {
    if (!messageNavigationRequest || messageNavigationItemIndex < 0) return;
    followOutputRef.current = false;
    virtuosoRef.current?.scrollToIndex({
      index: messageNavigationItemIndex,
      align: "center",
      behavior: "auto",
    });
    staticTranscriptRef.current
      ?.querySelector<HTMLElement>(`[data-transcript-item-index="${messageNavigationItemIndex}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [messageNavigationItemIndex, messageNavigationRequest]);
  useEffect(() => {
    if (hasOpeningScrollTarget) return;
    scrollToLatest();
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [hasOpeningScrollTarget, scrollToLatest]);
  useEffect(() => {
    const previous = latestUserRef.current;
    latestUserRef.current = { storeId: store.id, partId: latestUserPartId };
    if (
      !latestUserPartId ||
      !previous ||
      previous.storeId !== store.id ||
      previous.partId === latestUserPartId
    )
      return;
    store.setTranscriptScrollState(undefined);
    scrollToLatest();
    const frame = requestAnimationFrame(scrollToLatest);
    return () => cancelAnimationFrame(frame);
  }, [latestUserPartId, scrollToLatest, store]);
  const setVirtualScroller = useCallback((scroller: HTMLElement | null | Window) => {
    virtualScrollerRef.current = scroller instanceof HTMLElement ? scroller : null;
  }, []);
  useEffect(() => {
    const scroller = virtualScrollerRef.current;
    if (!scroller) return;
    let pendingScrollState = store.transcriptScrollState;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const commitScrollState = () => {
      saveTimer = undefined;
      if (pendingScrollState) store.setTranscriptScrollState(pendingScrollState);
    };
    const captureScrollState = () => {
      virtuosoRef.current?.getState((state) => {
        pendingScrollState = state;
        if (saveTimer !== undefined) clearTimeout(saveTimer);
        saveTimer = setTimeout(commitScrollState, 100);
      });
    };
    const stopFollowing = () => {
      followOutputRef.current = false;
    };
    const stopFollowingForScrollbar = (event: PointerEvent) => {
      // Native scrollbar pointer events target the scrolling element itself. Do
      // not depend on a fixed scrollbar width: overlay scrollbars and stable
      // gutters place the thumb differently across platforms.
      if (event.target === scroller) stopFollowing();
    };
    const stopFollowingForKeyboard = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        stopFollowing();
    };
    scroller.addEventListener("scroll", captureScrollState, { passive: true });
    scroller.addEventListener("wheel", stopFollowing, { passive: true });
    scroller.addEventListener("touchmove", stopFollowing, { passive: true });
    scroller.addEventListener("pointerdown", stopFollowingForScrollbar);
    scroller.addEventListener("keydown", stopFollowingForKeyboard);
    return () => {
      scroller.removeEventListener("scroll", captureScrollState);
      scroller.removeEventListener("wheel", stopFollowing);
      scroller.removeEventListener("touchmove", stopFollowing);
      scroller.removeEventListener("pointerdown", stopFollowingForScrollbar);
      scroller.removeEventListener("keydown", stopFollowingForKeyboard);
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      if (pendingScrollState) store.setTranscriptScrollState(pendingScrollState);
    };
  }, [store]);
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
      data-response-start={item.id === responseStartItemId ? "" : undefined}
      className={cn(
        "min-w-0 pb-5 in-[.chat-layout-compact]:pb-3.5",
        errorNoticeFollowsUser(items, index) && "pt-3",
      )}
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
        <div className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-6 pt-[42px] pb-[210px] [scrollbar-gutter:stable_both-edges] max-[620px]:px-4">
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
        <div
          ref={staticTranscriptRef}
          className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges]"
        >
          <TranscriptList>
            {items.map(renderItem)}
            <div className="mx-auto w-full max-w-[51rem] px-6 pb-[var(--composer-dock-height,210px)] max-[620px]:px-4 in-[.chat-layout-compact]:px-3 in-[.chat-layout-compact]:pb-2 in-[.chat-layout-compact]:min-h-0">
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
        key={store.id}
        ref={virtuosoRef}
        className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden [scrollbar-gutter:stable_both-edges] [overflow-anchor:none]"
        data={items}
        computeItemKey={(_index, item) => item.id}
        initialTopMostItemIndex={
          hasOpeningScrollTarget ? undefined : { index: items.length - 1, align: "end" }
        }
        restoreStateFrom={restoredScrollState}
        followOutput={followStreamingOutput}
        scrollerRef={setVirtualScroller}
        components={{
          List: TranscriptList,
          Footer: () => (
            <div className="mx-auto w-full max-w-[51rem] px-6 pb-[var(--composer-dock-height,210px)] max-[620px]:px-4 in-[.chat-layout-compact]:px-3 in-[.chat-layout-compact]:pb-2 in-[.chat-layout-compact]:min-h-0">
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
